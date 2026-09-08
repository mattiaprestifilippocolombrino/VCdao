// ============================================================================
//  test/gas/v3.bench.ts — V3 Topic-Based DAO · Gas Benchmark
//
//  Flusso utente misurato:
//    (1) joinDAO  →  (2) delegate  →  (3) registerDID  →  (4) upgradeSkillWithVC
//    →  (5) proposeWithTopic  →  (6) 10× castVote  →  (7) queue  →  (8) execute
//
//  Scenario fisso (comune a V0–V3):
//    Membri : 10  (6 For + 4 Against)
//    Stake  : 5 ETH · weightStake/weightSkill: 50/50
//    Quorum : 20%  |  Superquorum: 70%
//    VC     : 2 skill (cyberSecurity + cloudArchitecture)
//    Proposta: 10 ETH → MockStartup (topic FINTECH_BLOCKCHAIN)
//    Esito  : 6 For < 70% → Succeeded → Queue → Execute
//
//  Micro-benchmark scalabilità (solo V3):
//    upgradeSkillWithVC con 1, 2, 4, 6 e 8 skill (8 = full bitmap, worst case).
//
//  Gas: letto da ContractTransactionReceipt.gasUsed (hardhat-network).
//  Gas Price: rilevato dalla rete tramite ethers.provider.getFeeData() nel before().
//  Per abilitare hardhat-gas-reporter su stdout: rimuovi REPORT_GAS=false.
//
//  Eseguire con:
//    REPORT_GAS=false npx hardhat test test/gas/v3.bench.ts
// ============================================================================

import { ethers } from 'hardhat';
import {
    impersonateAccount,
    loadFixture,
    mine,
    setBalance,
    stopImpersonatingAccount,
    time,
} from '@nomicfoundation/hardhat-network-helpers';
import * as fs from 'fs';
import * as path from 'path';
import {
    GovernanceSkill, GovernanceToken, MyGovernor,
    Treasury, TimelockController, SkillCalculator, StartupRegistry,
} from '../../typechain-types';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { loadCredentialForAddress, EIP712_DOMAIN } from '../helpers/sharedCredentials';
import { ContractTransactionReceipt } from 'ethers';

// ── Costanti di scenario ────────────────────────────────────────────────────
const VOTING_DELAY = 1;
const VOTING_PERIOD = 50;
const TIMELOCK_DELAY = 3600;
const WEIGHT = 5000n;  // 50% in basis points
const QUORUM = 20;
const SUPERQUORUM = 70;
const STAKE_ETH = '5';
const MEMBER_COUNT = 10;
const FOR_VOTERS = 6;
const AGAINST_VOTERS = MEMBER_COUNT - FOR_VOTERS;

// Topic 2 = FINTECH_BLOCKCHAIN (alias WEB3 nello scenario della tesi)
const TOPIC_WEB3 = 2;

// ETH_PRICE_USD: media annuale Mainnet 2024 (fonte: CoinGecko).
// GAS_PRICE_WEI: media annuale Mainnet 2024 (fonte: Etherscan Gas Tracker).
//   Valori fissi per garantire misure riproducibili e confrontabili nella tesi.
const ETH_PRICE_USD = 2638.48;
const GAS_PRICE_WEI: bigint = 1_032_440_000n; // 1.03244 Gwei
const GAS_PRICE_GWEI_STR: string = "1.03244"; // media annuale Mainnet 2024

// VC_TYPES — schema EIP-712 identico a quello di VPVerifier.sol
const VC_TYPES = {
    VerifiableCredential: [
        { name: 'issuer', type: 'Issuer' },
        { name: 'issuanceDate', type: 'string' },
        { name: 'credentialSubject', type: 'CredentialSubject' },
    ],
    Issuer: [
        { name: 'id', type: 'string' },
    ],
    CredentialSubject: [
        { name: 'id', type: 'string' },
        { name: 'organization', type: 'string' },
        { name: 'unit', type: 'string' },
        { name: 'skills', type: 'string[]' },
    ],
};

// ── Tipi ────────────────────────────────────────────────────────────────────
interface GasMeasurement {
    operation: string;
    gasUsed: bigint;
    costEth: string;
    costUsd: string;
}
interface ScalabilityRow {
    skillCount: number;
    skills: string[];
    upgradeGas: bigint;
}

// ── Conversioni gas → ETH / USD ─────────────────────────────────────────────
function toEth(gas: bigint): string {
    return ethers.formatEther(gas * GAS_PRICE_WEI);
}
function toUsd(gas: bigint): string {
    const v = parseFloat(toEth(gas)) * ETH_PRICE_USD;
    if (v < 0.0001) return '< .0001';
    if (v < 0.01) return '$' + v.toFixed(5);
    if (v < 1) return '$' + v.toFixed(4);
    return '$' + v.toFixed(2);
}
function perMember(gas: bigint): bigint {
    return gas / BigInt(MEMBER_COUNT);
}
function rec(label: string, r: ContractTransactionReceipt): GasMeasurement {
    const gas = r.gasUsed;
    return { operation: label, gasUsed: gas, costEth: toEth(gas), costUsd: toUsd(gas) };
}

async function resolveNetworkGasPrice(): Promise<bigint> {
    const feeData = await ethers.provider.getFeeData();
    return feeData.gasPrice ?? feeData.maxFeePerGas ?? ethers.parseUnits('1', 'gwei');
}

// ── Stampa tabella principale ────────────────────────────────────────────────
function printTable(rows: GasMeasurement[], title: string) {
    const W = [50, 12, 20, 12];
    const LN = W.reduce((s, w) => s + w + 3, 0) - 1;
    const hr = '─'.repeat(LN);
    const pad = (s: string, n: number) => s.padEnd(n);
    const padL = (s: string, n: number) => s.padStart(n);
    console.log('\n' + hr);
    console.log('  ' + title);
    console.log('  Gas Price: ' + GAS_PRICE_GWEI_STR + ' Gwei  |  ETH: $' + ETH_PRICE_USD);
    console.log(hr);
    console.log('  ' + pad('Operation', W[0]) + ' │ ' + padL('Gas Used', W[1]) + ' │ ' + padL('Cost (ETH)', W[2]) + ' │ ' + padL('USD', W[3]));
    console.log(hr);
    for (const r of rows) {
        console.log('  ' + pad(r.operation, W[0]) + ' │ ' + padL(r.gasUsed.toString(), W[1]) + ' │ ' + padL(r.costEth, W[2]) + ' │ ' + padL(r.costUsd, W[3]));
    }
    console.log(hr);
}

// ── Stampa aggregati e totalGas ──────────────────────────────────────────────
function printAggregates(activation: bigint, cycle: bigint, totalGas: bigint) {
    const LN = 101;
    const hr = '─'.repeat(LN);
    const LABEL_W = 72;
    console.log('\n  AGGREGATED COSTS');
    console.log(hr);
    const rows = [
        { label: `${MEMBER_COUNT} Member Activation Cost (join + delegate + registerDID + upgrade)`, gas: activation },
        { label: `Governance Cycle Cost    (propose + ${MEMBER_COUNT}×vote + queue + execute)`, gas: cycle },
        { label: 'Per-Member Activation Estimate', gas: perMember(activation) },
        { label: 'Per-Member Cycle Share Estimate', gas: perMember(cycle) },
        { label: 'Per-Member Total Estimate', gas: perMember(totalGas) },
    ];
    for (const r of rows) {
        console.log('  ' + r.label.padEnd(LABEL_W) + ' │ ' + r.gas.toString().padStart(12) + ' gas │ ' + toUsd(r.gas).padStart(10));
    }
    console.log(hr);
    // Total Gas — riga in evidenza
    console.log('  ' + 'TOTAL GAS (activation + cycle)'.padEnd(LABEL_W) + ' │ ' + totalGas.toString().padStart(12) + ' gas │ ' + toUsd(totalGas).padStart(10));
    console.log(hr);
}

// ── Stampa tabella scalabilità ───────────────────────────────────────────────
function printScalability(rows: ScalabilityRow[]) {
    const LN = 72;
    const hr = '─'.repeat(LN);
    console.log('\n  TOPIC SCALABILITY — upgradeSkillWithVC gas cost vs. #skills in VC');
    console.log(hr);
    console.log('  ' + '#Skills'.padEnd(10) + ' │ ' + 'Skills'.padEnd(38) + ' │ ' + 'Gas Used'.padStart(10) + ' │ ' + 'USD'.padStart(8));
    console.log(hr);
    for (const r of rows) {
        console.log('  ' + String(r.skillCount).padEnd(10) + ' │ ' + r.skills.join(', ').padEnd(38) + ' │ ' + r.upgradeGas.toString().padStart(10) + ' │ ' + toUsd(r.upgradeGas).padStart(8));
    }
    console.log(hr);
}

// ── Fixture di deploy ────────────────────────────────────────────────────────
async function deployFixture() {
    const signers = await ethers.getSigners();
    const deployer = signers[0];
    const issuer = signers[2];
    const members = [signers[1], ...signers.slice(3, 3 + MEMBER_COUNT - 1)];

    if (members.length !== MEMBER_COUNT)
        throw new Error(`not enough signers for ${MEMBER_COUNT} benchmark members`);

    const cred1 = loadCredentialForAddress(members[0].address);
    const cred2 = loadCredentialForAddress(members[1].address);

    if (cred1.issuerAddress !== issuer.address)
        throw new Error('issuer address mismatch: VC issuer != signer[2]');

    // 1. TimelockController
    const TL = await ethers.getContractFactory('TimelockController');
    const timelock = await TL.deploy(TIMELOCK_DELAY, [], [], deployer.address) as unknown as TimelockController;
    await timelock.waitForDeployment();

    // 2. GovernanceToken
    const TK = await ethers.getContractFactory('GovernanceToken');
    const token = await TK.deploy(await timelock.getAddress(), WEIGHT, WEIGHT) as unknown as GovernanceToken;
    await token.waitForDeployment();

    // 3. Treasury
    const TR = await ethers.getContractFactory('Treasury');
    const treasury = await TR.deploy(await timelock.getAddress()) as unknown as Treasury;
    await treasury.waitForDeployment();
    await token.setTreasury(await treasury.getAddress());

    // 4. StartupRegistry
    const SR = await ethers.getContractFactory('StartupRegistry');
    const registry = await SR.deploy(await timelock.getAddress()) as unknown as StartupRegistry;
    await registry.waitForDeployment();

    // 5. MockStartup
    const MS = await ethers.getContractFactory('MockStartup');
    const mockStartup = await MS.deploy();
    await mockStartup.waitForDeployment();

    // 6. SkillCalculator
    const SC = await ethers.getContractFactory('SkillCalculator');
    const calculator = await SC.deploy() as unknown as SkillCalculator;
    await calculator.waitForDeployment();

    // 7. GovernanceSkill
    const GS = await ethers.getContractFactory('GovernanceSkill');
    const skillModule = await GS.deploy(
        await token.getAddress(),
        await timelock.getAddress(),
        WEIGHT,
        await calculator.getAddress(),
    ) as unknown as GovernanceSkill;
    await skillModule.waitForDeployment();
    await skillModule.setTrustedIssuer(issuer.address);

    // 8. MyGovernor
    const GV = await ethers.getContractFactory('MyGovernor');
    const governor = await GV.deploy(
        await token.getAddress(),
        await skillModule.getAddress(),
        await timelock.getAddress(),
        VOTING_DELAY, VOTING_PERIOD, 0, QUORUM, SUPERQUORUM,
    ) as unknown as MyGovernor;
    await governor.waitForDeployment();

    // Ruoli Timelock
    const govAddr = await governor.getAddress();
    await timelock.grantRole(await timelock.PROPOSER_ROLE(), govAddr);
    await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
    await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);

    return {
        deployer, members, issuer,
        token, skillModule, governor, treasury, timelock, registry, mockStartup,
        cred1, cred2
    };
}

// ── Costruisce e firma una VC sintetica a runtime ────────────────────────────
async function buildSyntheticVC(
    issuerSigner: HardhatEthersSigner,
    holderAddr: string,
    skillNames: string[],
) {
    const issuerDid = 'did:ethr:' + issuerSigner.address;
    const holderDid = 'did:ethr:' + holderAddr;
    const vcData = {
        issuer: { id: issuerDid },
        issuanceDate: '2025-01-01T00:00:00Z',
        credentialSubject: {
            id: holderDid,
            organization: 'BenchmarkOrg',
            unit: 'Engineering',
            skills: skillNames,
        },
    };
    const sig = await issuerSigner.signTypedData(EIP712_DOMAIN as any, VC_TYPES as any, vcData);
    return { vcData, sig };
}

// ============================================================================
//  SUITE PRINCIPALE
// ============================================================================
describe('V3 — Topic-Based DAO │ Gas Benchmark', function () {

    const flowMeasurements: GasMeasurement[] = [];
    const scalabilityRows: ScalabilityRow[] = [];

    // Il benchmark usa costanti fisse annuali per garantire misure riproducibili.
    // Il gas price di rete viene letto e loggato solo come riferimento informativo.
    before(async function () {
        const rawGasPrice = await resolveNetworkGasPrice();
        const networkGweiStr = (Number(rawGasPrice) / 1e9).toFixed(4);
        console.log('\n  [GasBench] Gas Price rete (solo info):  ' + networkGweiStr + ' Gwei');
        console.log('  [GasBench] Gas Price benchmark (fisso): ' + GAS_PRICE_GWEI_STR + ' Gwei  |  ETH: $' + ETH_PRICE_USD);
    });

    // ── Flusso utente principale ─────────────────────────────────────────────
    //  Flusso lineare: ogni it() esegue una fase, condivide lo stesso stato EVM.
    //  Tutti e 10 i membri partecipano a ogni fase.
    // ─────────────────────────────────────────────────────────────────────────
    describe('Main User Flow', function () {
        let ctx: Awaited<ReturnType<typeof deployFixture>>;
        let proposalId: bigint;
        let proposalCalldata: string;
        let proposalDescHash: string;

        before(async function () {
            ctx = await loadFixture(deployFixture);
        });

        // ── 1. JOIN DAO ───────────────────────────────────────────────────────
        //  Tutti e 10 i membri depositano 5 ETH e ricevono i governance token.
        it('1. joinDAO — 10 members, 5 ETH each', async function () {
            const { token, members } = ctx;
            const v = ethers.parseEther(STAKE_ETH);

            for (let i = 0; i < members.length; i++) {
                const r = await (await token.connect(members[i]).joinDAO({ value: v })).wait();
                flowMeasurements.push(rec(`joinDAO  (member ${i + 1})`, r!));
            }
        });

        // ── 2. DELEGATE ───────────────────────────────────────────────────────
        //  Ogni membro si auto-delega per attivare il proprio voting power
        //  sul token ERC20Votes (crea il primo checkpoint).
        it('2. delegate — self-delegation, all 10 members', async function () {
            const { token, members } = ctx;

            for (let i = 0; i < members.length; i++) {
                const m = members[i];
                const r = await (await token.connect(m).delegate(m.address)).wait();
                flowMeasurements.push(rec(`delegate (member ${i + 1})`, r!));
            }
        });

        // ── 3. REGISTER DID ───────────────────────────────────────────────────
        //  Tutti e 10 i membri registrano il proprio DID on-chain.
        //  Il DID serve come anchor di identità per la verifica della VC.
        it('3. registerDID — all 10 members anchor their DID', async function () {
            const { skillModule, members, issuer, cred1, cred2 } = ctx;

            // Primi due membri con VC reali condivise.
            const r1 = await (await skillModule.connect(members[0])
                .registerDID(cred1.vcData.credentialSubject.id)).wait();
            flowMeasurements.push(rec('registerDID (member 1)', r1!));

            const r2 = await (await skillModule.connect(members[1])
                .registerDID(cred2.vcData.credentialSubject.id)).wait();
            flowMeasurements.push(rec('registerDID (member 2)', r2!));

            // Gli altri membri usano DID sintetici firmati dallo stesso issuer.
            for (let i = 2; i < members.length; i++) {
                const { vcData } = await buildSyntheticVC(issuer, members[i].address, ['cyberSecurity']);
                const r = await (await skillModule.connect(members[i])
                    .registerDID(vcData.credentialSubject.id)).wait();
                flowMeasurements.push(rec(`registerDID (member ${i + 1})`, r!));
            }
        });

        // ── 4. UPGRADE SKILL WITH VC ──────────────────────────────────────────
        //  Tutti e 10 i membri presentano la loro VC e ottengono il VP skill.
        //  Questo passaggio esegue: verifica EIP-712 + aggiornamento bitmap
        //  + aggiornamento dei checkpoint per tutti e 4 i topic.
        it('4. upgradeSkillWithVC — all 10 members get competence VP', async function () {
            const { skillModule, members, issuer, cred1, cred2 } = ctx;

            // Primi due membri con VC reali.
            const r1 = await (await skillModule.connect(members[0])
                .upgradeSkillWithVC(cred1.vcData, cred1.signature)).wait();
            flowMeasurements.push(rec('upgradeSkillWithVC  (member 1)', r1!));

            const r2 = await (await skillModule.connect(members[1])
                .upgradeSkillWithVC(cred2.vcData, cred2.signature)).wait();
            flowMeasurements.push(rec('upgradeSkillWithVC  (member 2)', r2!));

            // Skill sintetiche distribuite per garantire che 6 voti For non
            // raggiungano il superquorum 70%, pur superando il quorum ordinario.
            const extraSkills = [
                ['distributedSystems', 'blockchain'],
                ['cyberSecurity', 'cloudArchitecture'],
                ['softwareArchitecture', 'dataEngineering'],
                ['blockchain', 'startupFinance'],
                ['machineLearning', 'dataEngineering'],
                ['cloudArchitecture', 'softwareArchitecture'],
                ['cyberSecurity', 'blockchain'],
                ['distributedSystems', 'startupFinance'],
            ];
            for (let i = 2; i < members.length; i++) {
                const { vcData, sig } = await buildSyntheticVC(issuer, members[i].address, extraSkills[i - 2]);
                const r = await (await skillModule.connect(members[i]).upgradeSkillWithVC(vcData, sig)).wait();
                flowMeasurements.push(rec(`upgradeSkillWithVC  (member ${i + 1})`, r!));
            }
        });

        // ── 5. PROPOSE WITH TOPIC ─────────────────────────────────────────────
        //  Il primo membro crea la proposta: investimento di 10 ETH in MockStartup WEB3.
        //  Topic = FINTECH_BLOCKCHAIN (alias WEB3 nello scenario della tesi).
        //  Il topicId viene salvato in proposalTopic[proposalId] on-chain.
        it('5. proposeWithTopic — invest 10 ETH in MockStartup WEB3', async function () {
            const { governor, treasury, mockStartup, timelock, registry, deployer, members } = ctx;

            // Setup infrastrutturale (non misurato):
            //   - fondi il treasury con 15 ETH (10 per l'investimento + margine)
            //   - registra la startup nel registry tramite impersonazione del Timelock
            await deployer.sendTransaction({
                to: await treasury.getAddress(),
                value: ethers.parseEther('15'),
            });
            await treasury.setStartupRegistry(await registry.getAddress());

            const tlAddr = await timelock.getAddress();
            await setBalance(tlAddr, ethers.parseEther('1'));
            await impersonateAccount(tlAddr);
            const tlSigner = await ethers.getSigner(tlAddr);
            try {
                await registry.connect(tlSigner).registerStartup(
                    'MockStartup WEB3',
                    await mockStartup.getAddress(),
                    'Web3 infrastructure startup',
                );
            } finally {
                await stopImpersonatingAccount(tlAddr);
            }

            // Calldata: Treasury.investStartup(startupId=0, amount=10 ETH)
            const ifaceT = (await ethers.getContractFactory('Treasury')).interface;
            proposalCalldata = ifaceT.encodeFunctionData('investStartup', [
                0n,
                ethers.parseEther('10'),
            ]);
            const desc = 'Invest 10 ETH in MockStartup WEB3 — topic: FINTECH_BLOCKCHAIN';
            proposalDescHash = ethers.id(desc);

            await mine(1); // assicura che lo snapshot VP includa gli upgrade

            // Misurato
            const r = await (await governor.connect(members[0]).proposeWithTopic(
                [await treasury.getAddress()],
                [0n],
                [proposalCalldata],
                desc,
                TOPIC_WEB3,
            )).wait();
            flowMeasurements.push(rec('proposeWithTopic   (topicId stored + ProposalCreated)', r!));

            // Leggiamo il proposalId dall'evento ProposalCreated
            const log = r!.logs
                .map((l: any) => { try { return governor.interface.parseLog(l); } catch { return null; } })
                .find((p: any) => p?.name === 'ProposalCreated');
            proposalId = log!.args!.proposalId;
        });

        // ── 6. CAST VOTE — tutti e 10 i membri votano ────────────────────────
        //  6 For + 4 Against.
        //  Il VP di ogni votante è calcolato on-chain come:
        //    stakeVP (ERC20Votes) + skillVP (checkpoint del topic WEB3)
        //  Con 10 membri dal VP simile, 6 For != 70% del totale → no superquorum.
        //  Il voting period si conclude naturalmente → Succeeded → Queue → Execute.
        it('6. castVote — 6 For + 4 Against (all 10 members vote)', async function () {
            const { governor, members } = ctx;

            // Salta il voting delay
            await mine(VOTING_DELAY + 1);

            for (let i = 0; i < members.length; i++) {
                const support = i < FOR_VOTERS ? 1 : 0;
                const label = support === 1 ? 'For' : 'Against';
                const r = await (await governor.connect(members[i]).castVote(proposalId, support)).wait();
                flowMeasurements.push(rec(`castVote ${label.padEnd(7)} (member ${i + 1})`, r!));
            }
        });

        // ── 7. QUEUE ──────────────────────────────────────────────────────────
        //  Dopo la fine del voting period (Succeeded), la proposta viene messa
        //  in coda nel TimelockController per il ritardo di sicurezza.
        it('7. queue — proposal queued in TimelockController', async function () {
            const { governor, treasury } = ctx;

            // Salta il voting period
            await mine(VOTING_PERIOD);

            const r = await (await governor.queue(
                [await treasury.getAddress()],
                [0n],
                [proposalCalldata],
                proposalDescHash,
            )).wait();
            flowMeasurements.push(rec('queue', r!));
        });

        // ── 8. EXECUTE ────────────────────────────────────────────────────────
        //  Dopo il timelock delay, il Governor esegue la proposta:
        //  Timelock → Treasury.investStartup(0, 10 ETH) → MockStartup.
        it('8. execute — Treasury.investStartup(10 ETH) via TimelockController', async function () {
            const { governor, treasury } = ctx;

            // Salta il timelock delay
            await time.increase(TIMELOCK_DELAY + 1);

            const r = await (await governor.execute(
                [await treasury.getAddress()],
                [0n],
                [proposalCalldata],
                proposalDescHash,
            )).wait();
            flowMeasurements.push(rec('execute            (Timelock → Treasury.investStartup)', r!));
        });

        // ── REPORT ────────────────────────────────────────────────────────────
        it('REPORT — Main Flow', function () {
            if (flowMeasurements.length === 0) return;

            printTable(
                flowMeasurements,
                'V3 — Topic-Based DAO │ ' + GAS_PRICE_GWEI_STR + ' Gwei · ETH $' + ETH_PRICE_USD
                + ` │ ${MEMBER_COUNT} members: ${FOR_VOTERS} For + ${AGAINST_VOTERS} Against`,
            );

            const find = (prefix: string) =>
                flowMeasurements.find(m => m.operation.startsWith(prefix))!.gasUsed;
            const sum = (prefix: string) =>
                flowMeasurements.filter(m => m.operation.startsWith(prefix)).reduce((s, m) => s + m.gasUsed, 0n);

            const activation = sum('joinDAO') + sum('delegate') + sum('registerDID') + sum('upgradeSkillWithVC');
            const cycle = find('proposeWithTopic') + sum('castVote') + find('queue') + find('execute');
            const totalGas = activation + cycle;

            printAggregates(activation, cycle, totalGas);
        });
    });

    // ── Micro-benchmark di scalabilità (solo V3) ───────────────────────────
    //
    //  Misura upgradeSkillWithVC al variare del numero di skill nella VC:
    //    1 → 2 → 4 → 6 → 8 (full bitmap = worst case / upper bound).
    //
    //  I 4 topic checkpoint vengono sempre scritti indipendentemente dal numero
    //  di skill: il delta tra i casi isola il costo del solo parsing EIP-712
    //  (hashing delle stringhe skill) e dell'aggiornamento del bitmap on-chain.
    //
    //  Ogni caso usa una fixture fresca (loadFixture) per misure indipendenti.
    //  Gas letto da: ContractTransactionReceipt.gasUsed (hardhat-network).
    describe('Topic Scalability — upgradeSkillWithVC vs. #skills in VC', function () {

        // Deploya una fixture pulita, registra il DID e misura solo l'upgrade.
        async function runScalabilityUpgrade(skillNames: string[]): Promise<bigint> {
            const ctx = await loadFixture(deployFixture);
            const { token, skillModule, issuer, members } = ctx;
            const member = members[2];

            // Infrastruttura minima (non misurata)
            await token.connect(member).joinDAO({ value: ethers.parseEther(STAKE_ETH) });
            await token.connect(member).delegate(member.address);
            const { vcData, sig } = await buildSyntheticVC(issuer, member.address, skillNames);
            await skillModule.connect(member).registerDID(vcData.credentialSubject.id);

            // Misurato: solo upgradeSkillWithVC
            const r = await (await skillModule.connect(member).upgradeSkillWithVC(vcData, sig)).wait();
            return r!.gasUsed;
        }

        it('1 skill  — cyberSecurity', async function () {
            const gas = await runScalabilityUpgrade(['cyberSecurity']);
            scalabilityRows.push({ skillCount: 1, skills: ['cyberSecurity'], upgradeGas: gas });
        });

        it('2 skills — cyberSecurity + cloudArchitecture', async function () {
            const gas = await runScalabilityUpgrade(['cyberSecurity', 'cloudArchitecture']);
            scalabilityRows.push({ skillCount: 2, skills: ['cyberSecurity', 'cloudArchitecture'], upgradeGas: gas });
        });

        it('4 skills — blockchain + cloudArchitecture + cyberSecurity + distributedSystems', async function () {
            const skills = ['blockchain', 'cloudArchitecture', 'cyberSecurity', 'distributedSystems'];
            const gas = await runScalabilityUpgrade(skills);
            scalabilityRows.push({ skillCount: 4, skills, upgradeGas: gas });
        });

        it('6 skills — adds machineLearning + dataEngineering', async function () {
            const skills = [
                'blockchain',
                'cloudArchitecture',
                'cyberSecurity',
                'distributedSystems',
                'machineLearning',
                'dataEngineering',
            ];
            const gas = await runScalabilityUpgrade(skills);
            scalabilityRows.push({ skillCount: 6, skills, upgradeGas: gas });
        });

        it('8 skills — full bitmap (all skills — worst case)', async function () {
            // Tutti e 8 i bit del SUPPORTED_SKILL_MASK impostati (0xFF).
            // È il worst case dell'algoritmo _performUpgrade:
            //   - EIP-712 hashing di 8 stringhe skill nella calldata
            //   - aggiornamento bitmap completo (tutti i bit a 1)
            //   - aggiornamento dei 4 topic checkpoint (invariante rispetto al #skill)
            // Il confronto 4-skill vs 8-skill mostra il costo marginale
            // del parsing delle stringhe — non dello storage (già warm dopo 4).
            const skills = [
                'machineLearning',
                'dataEngineering',
                'cyberSecurity',
                'cloudArchitecture',
                'distributedSystems',
                'blockchain',
                'softwareArchitecture',
                'startupFinance',
            ];
            const gas = await runScalabilityUpgrade(skills);
            scalabilityRows.push({ skillCount: 8, skills, upgradeGas: gas });
        });

        it('REPORT — Scalability', function () {
            if (scalabilityRows.length === 0) return;
            printScalability(scalabilityRows);
        });
    });

    // ── Esportazione JSON ────────────────────────────────────────────────────
    after(function () {
        if (flowMeasurements.length === 0) return;

        const find = (prefix: string) =>
            flowMeasurements.find(m => m.operation.startsWith(prefix))?.gasUsed ?? 0n;
        const sum = (prefix: string) =>
            flowMeasurements.filter(m => m.operation.startsWith(prefix)).reduce((s, m) => s + m.gasUsed, 0n);

        const activation = sum('joinDAO') + sum('delegate') + sum('registerDID') + sum('upgradeSkillWithVC');
        const cycle = find('proposeWithTopic') + sum('castVote') + find('queue') + find('execute');
        const totalGas = activation + cycle;

        const result = {
            version: 'V3-TopicBased',
            timestamp: new Date().toISOString(),
            gasPriceGwei: Number(GAS_PRICE_WEI) / 1e9,
            ethPriceUsd: ETH_PRICE_USD,
            scenario: {
                members: MEMBER_COUNT,
                stakeEth: Number(STAKE_ETH),
                weightStakeBp: Number(WEIGHT),
                weightSkillBp: Number(WEIGHT),
                quorumPct: QUORUM,
                superquorumPct: SUPERQUORUM,
                vcSkills: ['cyberSecurity', 'cloudArchitecture'],
                proposalAmountEth: 10,
                proposalTopic: 'FINTECH_BLOCKCHAIN (WEB3)',
                proposalTopicId: TOPIC_WEB3,
                votersFor: FOR_VOTERS,
                votersAgainst: AGAINST_VOTERS,
            },
            flow: flowMeasurements.map(m => ({
                operation: m.operation,
                gasUsed: m.gasUsed.toString(),
                costEth: m.costEth,
                costUsd: m.costUsd,
            })),
            aggregates: {
                memberActivationCost: { gas: activation.toString(), usd: toUsd(activation) },
                governanceCycleCost: { gas: cycle.toString(), usd: toUsd(cycle) },
                totalGas: { gas: totalGas.toString(), usd: toUsd(totalGas) },
                perMemberEstimates: {
                    activation: {
                        gas: perMember(activation).toString(),
                        usd: toUsd(perMember(activation)),
                    },
                    cycleShare: {
                        gas: perMember(cycle).toString(),
                        usd: toUsd(perMember(cycle)),
                    },
                    total: {
                        gas: perMember(totalGas).toString(),
                        usd: toUsd(perMember(totalGas)),
                    },
                },
            },
            scalability: scalabilityRows.map(r => ({
                skillCount: r.skillCount,
                skills: r.skills,
                upgradeGas: r.upgradeGas.toString(),
                costEth: toEth(r.upgradeGas),
                costUsd: toUsd(r.upgradeGas),
            })),
        };

        const outPath = path.resolve(__dirname, '../../benchmark-v3.json');
        fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
        console.log('\n  ✓ JSON written to: ' + outPath + '\n');
    });
});

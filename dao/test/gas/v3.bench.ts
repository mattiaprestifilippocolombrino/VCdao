// ============================================================================
//  test/gas/v3.bench.ts — V3 Topic-Based DAO · Gas Benchmark
//
//  Flusso utente misurato:
//    (1) joinDAO  →  (2) delegate  →  (3) registerDID  →  (4) upgradeSkillWithVC
//    →  (5) proposeWithTopic  →  (6) 5× castVote  →  (7) queue  →  (8) execute
//
//  Scenario fisso (comune a V0–V3):
//    Membri : 5  (3 For + 2 Against)
//    Stake  : 5 ETH · weightStake/weightSkill: 50/50
//    Quorum : 20%  |  Superquorum: 70%
//    VC     : 2 skill (cyberSecurity + cloudArchitecture)
//    Proposta: 10 ETH → MockStartup (topic FINTECH_BLOCKCHAIN)
//    Esito  : 3 For < 70% → Succeeded → Queue → Execute
//
//  Micro-benchmark scalabilità (solo V3):
//    upgradeSkillWithVC con 1, 2, 4 e 8 skill (8 = full bitmap, worst case).
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

// Topic 2 = FINTECH_BLOCKCHAIN (alias WEB3 nello scenario della tesi)
const TOPIC_WEB3 = 2;

// ETH_PRICE_USD: scenario reference price (USD per ETH).
// GAS_PRICE_WEI: read dynamically via ethers.provider.getFeeData() in before().
//   Fallback = 1 Gwei if the connected provider does not expose fee data.
const ETH_PRICE_USD = 2500;
let GAS_PRICE_WEI: bigint = 1n * 10n ** 9n;  // fallback: 1 Gwei
let GAS_PRICE_GWEI_STR: string = '<pending>'; // resolved in before()

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
    const LN = 87;
    const hr = '─'.repeat(LN);
    console.log('\n  AGGREGATED COSTS');
    console.log(hr);
    const rows = [
        { label: 'Member Activation Cost   (join + delegate + registerDID + upgrade)', gas: activation },
        { label: 'Governance Cycle Cost    (propose + 5×vote + queue + execute)', gas: cycle },
    ];
    for (const r of rows) {
        console.log('  ' + r.label.padEnd(58) + ' │ ' + r.gas.toString().padStart(12) + ' gas │ ' + toUsd(r.gas).padStart(10));
    }
    console.log(hr);
    // Total Gas — riga in evidenza
    console.log('  ' + 'TOTAL GAS (activation + cycle)'.padEnd(58) + ' │ ' + totalGas.toString().padStart(12) + ' gas │ ' + toUsd(totalGas).padStart(10));
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
    // signer[0]=deployer  [1]=member1  [2]=issuer  [3]=member2  [4]=member3
    // [5]=member4  [6]=member5
    const deployer = signers[0];
    const member1 = signers[1];
    const issuer = signers[2];
    const member2 = signers[3];
    const member3 = signers[4];
    const member4 = signers[5];
    const member5 = signers[6];

    const cred1 = loadCredentialForAddress(member1.address);
    const cred2 = loadCredentialForAddress(member2.address);

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
        deployer, member1, member2, member3, member4, member5, issuer,
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

    // Legge il gas price direttamente dalla rete Hardhat all'avvio della suite.
    // Con hardhat-network arriva dal provider locale; su altre reti dal provider configurato.
    before(async function () {
        const rawGasPrice = await resolveNetworkGasPrice();
        GAS_PRICE_WEI = rawGasPrice;
        const gweiFloat = Number(rawGasPrice) / 1e9;
        GAS_PRICE_GWEI_STR = gweiFloat.toFixed(4);
        console.log('\n  [GasBench] Gas Price letto dalla rete: ' + GAS_PRICE_GWEI_STR + ' Gwei  |  ETH: $' + ETH_PRICE_USD);
    });

    // ── Flusso utente principale ─────────────────────────────────────────────
    //  Flusso lineare: ogni it() esegue una fase, condivide lo stesso stato EVM.
    //  Tutti e 5 i membri partecipano a ogni fase.
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
        //  Tutti e 5 i membri depositano 5 ETH e ricevono i governance token.
        //  Si misura il primo joinDAO (cold SSTORE, costo massimo).
        it('1. joinDAO — 5 members, 5 ETH each', async function () {
            const { token, member1, member2, member3, member4, member5 } = ctx;
            const v = ethers.parseEther(STAKE_ETH);

            // Misurato: primo membro (cold SSTORE — costo più alto)
            const r1 = await (await token.connect(member1).joinDAO({ value: v })).wait();
            flowMeasurements.push(rec('joinDAO  (first member — cold SSTORE)', r1!));

            // Non misurati: gli altri 4 membri (warm SSTORE, costo inferiore)
            for (const m of [member2, member3, member4, member5])
                await token.connect(m).joinDAO({ value: v });
        });

        // ── 2. DELEGATE ───────────────────────────────────────────────────────
        //  Ogni membro si auto-delega per attivare il proprio voting power
        //  sul token ERC20Votes (crea il primo checkpoint).
        it('2. delegate — self-delegation, all 5 members', async function () {
            const { token, member1, member2, member3, member4, member5 } = ctx;

            // Misurato: primo membro (crea il primo checkpoint — costo più alto)
            const r1 = await (await token.connect(member1).delegate(member1.address)).wait();
            flowMeasurements.push(rec('delegate (first — creates checkpoint)', r1!));

            // Non misurati: gli altri 4 (stesso comportamento)
            for (const m of [member2, member3, member4, member5])
                await token.connect(m).delegate(m.address);
        });

        // ── 3. REGISTER DID ───────────────────────────────────────────────────
        //  Tutti e 5 i membri registrano il proprio DID on-chain.
        //  Il DID serve come anchor di identità per la verifica della VC.
        //  Si misura il primo registerDID (cold SSTORE).
        it('3. registerDID — all 5 members anchor their DID', async function () {
            const { skillModule, member1, member2, member3, member4, member5,
                issuer, cred1, cred2 } = ctx;

            // Misurato: primo membro con VC reale
            const r1 = await (await skillModule.connect(member1)
                .registerDID(cred1.vcData.credentialSubject.id)).wait();
            flowMeasurements.push(rec('registerDID (first member — cold SSTORE)', r1!));

            // Non misurati: gli altri 4
            await skillModule.connect(member2).registerDID(cred2.vcData.credentialSubject.id);

            // member3, member4, member5: DID sintetico (stesso costo strutturale)
            const others = [member3, member4, member5];
            for (const m of others) {
                const { vcData } = await buildSyntheticVC(issuer, m.address, ['cyberSecurity']);
                await skillModule.connect(m).registerDID(vcData.credentialSubject.id);
            }
        });

        // ── 4. UPGRADE SKILL WITH VC ──────────────────────────────────────────
        //  Tutti e 5 i membri presentano la loro VC e ottengono il VP skill.
        //  Si misura il primo upgrade (member1, VC reale EIP-712).
        //  Questo passaggio esegue: verifica EIP-712 + aggiornamento bitmap
        //  + aggiornamento dei checkpoint per tutti e 4 i topic.
        it('4. upgradeSkillWithVC — all 5 members get competence VP', async function () {
            const { skillModule, member1, member2, member3, member4, member5,
                issuer, cred1, cred2 } = ctx;

            // Misurato: member1 con VC reale (cyberSecurity + cloudArchitecture)
            const r = await (await skillModule.connect(member1)
                .upgradeSkillWithVC(cred1.vcData, cred1.signature)).wait();
            flowMeasurements.push(rec('upgradeSkillWithVC  (EIP-712 + bitmap + 4-topic checkpoints)', r!));

            // Non misurati: member2 con VC reale
            await skillModule.connect(member2).upgradeSkillWithVC(cred2.vcData, cred2.signature);

            // Non misurati: member3/4/5 con skill sintetiche
            // (distribuite per garantire che 3 voti For non raggiungano il superquorum 70%)
            const extras = [member3, member4, member5];
            const extraSkills = [
                ['distributedSystems', 'blockchain'],
                ['cyberSecurity', 'cloudArchitecture'],
                ['softwareArchitecture', 'dataEngineering'],
            ];
            for (let i = 0; i < extras.length; i++) {
                const { vcData, sig } = await buildSyntheticVC(issuer, extras[i].address, extraSkills[i]);
                await skillModule.connect(extras[i]).upgradeSkillWithVC(vcData, sig);
            }
        });

        // ── 5. PROPOSE WITH TOPIC ─────────────────────────────────────────────
        //  member1 crea la proposta: investimento di 10 ETH in MockStartup WEB3.
        //  Topic = FINTECH_BLOCKCHAIN (alias WEB3 nello scenario della tesi).
        //  Il topicId viene salvato in proposalTopic[proposalId] on-chain.
        it('5. proposeWithTopic — invest 10 ETH in MockStartup WEB3', async function () {
            const { governor, treasury, mockStartup, timelock, registry, deployer, member1 } = ctx;

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
            const r = await (await governor.connect(member1).proposeWithTopic(
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

        // ── 6. CAST VOTE — tutti e 5 i membri votano ─────────────────────────
        //  3 For (member1, member2, member3) + 2 Against (member4, member5).
        //  Il VP di ogni votante è calcolato on-chain come:
        //    stakeVP (ERC20Votes) + skillVP (checkpoint del topic WEB3)
        //  Con 5 membri dal VP simile, 3 For != 70% del totale → no superquorum.
        //  Il voting period si conclude naturalmente → Succeeded → Queue → Execute.
        it('6. castVote — 3 For + 2 Against (all 5 members vote)', async function () {
            const { governor, member1, member2, member3, member4, member5 } = ctx;

            // Salta il voting delay
            await mine(VOTING_DELAY + 1);

            // For
            const r1 = await (await governor.connect(member1).castVote(proposalId, 1)).wait();
            flowMeasurements.push(rec('castVote For       (1st — topic-aware VP calc)', r1!));

            const r2 = await (await governor.connect(member2).castVote(proposalId, 1)).wait();
            flowMeasurements.push(rec('castVote For       (2nd voter)', r2!));

            const r3 = await (await governor.connect(member3).castVote(proposalId, 1)).wait();
            flowMeasurements.push(rec('castVote For       (3rd voter)', r3!));

            // Against
            const r4 = await (await governor.connect(member4).castVote(proposalId, 0)).wait();
            flowMeasurements.push(rec('castVote Against   (4th voter)', r4!));

            const r5 = await (await governor.connect(member5).castVote(proposalId, 0)).wait();
            flowMeasurements.push(rec('castVote Against   (5th voter)', r5!));
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
                + ' │ 5 members: 3 For + 2 Against',
            );

            const find = (prefix: string) =>
                flowMeasurements.find(m => m.operation.startsWith(prefix))!.gasUsed;
            const sum = (prefix: string) =>
                flowMeasurements.filter(m => m.operation.startsWith(prefix)).reduce((s, m) => s + m.gasUsed, 0n);

            const activation = find('joinDAO') + find('delegate') + find('registerDID') + find('upgradeSkillWithVC');
            const cycle = find('proposeWithTopic') + sum('castVote') + find('queue') + find('execute');
            const totalGas = activation + cycle;

            printAggregates(activation, cycle, totalGas);
        });
    });

    // ── Micro-benchmark di scalabilità (solo V3) ───────────────────────────
    //
    //  Misura upgradeSkillWithVC al variare del numero di skill nella VC:
    //    1 → 2 → 4 → 8 (full bitmap = worst case / upper bound).
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
            const { token, skillModule, issuer, member3 } = ctx;

            // Infrastruttura minima (non misurata)
            await token.connect(member3).joinDAO({ value: ethers.parseEther(STAKE_ETH) });
            await token.connect(member3).delegate(member3.address);
            const { vcData, sig } = await buildSyntheticVC(issuer, member3.address, skillNames);
            await skillModule.connect(member3).registerDID(vcData.credentialSubject.id);

            // Misurato: solo upgradeSkillWithVC
            const r = await (await skillModule.connect(member3).upgradeSkillWithVC(vcData, sig)).wait();
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

        const activation = find('joinDAO') + find('delegate') + find('registerDID') + find('upgradeSkillWithVC');
        const cycle = find('proposeWithTopic') + sum('castVote') + find('queue') + find('execute');
        const totalGas = activation + cycle;

        const result = {
            version: 'V3-TopicBased',
            timestamp: new Date().toISOString(),
            gasPriceGwei: Number(GAS_PRICE_WEI) / 1e9,
            ethPriceUsd: ETH_PRICE_USD,
            scenario: {
                members: 5,
                stakeEth: Number(STAKE_ETH),
                weightStakeBp: Number(WEIGHT),
                weightSkillBp: Number(WEIGHT),
                quorumPct: QUORUM,
                superquorumPct: SUPERQUORUM,
                vcSkills: ['cyberSecurity', 'cloudArchitecture'],
                proposalAmountEth: 10,
                proposalTopic: 'FINTECH_BLOCKCHAIN (WEB3)',
                proposalTopicId: TOPIC_WEB3,
                votersFor: 3,
                votersAgainst: 2,
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

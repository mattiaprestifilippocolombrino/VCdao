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
interface ExportFlowRow {
    operation: string;
    gasUsed: string;
    costEth: string;
    costUsd: string;
}
interface ExportScalabilityRow {
    skillCount: number;
    skills: string[];
    upgradeGas: string;
    costEth: string;
    costUsd: string;
}
interface BenchmarkExport {
    version: string;
    timestamp: string;
    gasPriceGwei: number;
    ethPriceUsd: number;
    scenario: {
        members: number;
        stakeEth: number;
        weightStakeBp: number;
        weightSkillBp: number;
        quorumPct: number;
        superquorumPct: number;
        vcSkills: string[];
        proposalAmountEth: number;
        proposalTopic: string;
        proposalTopicId: number;
        votersFor: number;
        votersAgainst: number;
    };
    flow: ExportFlowRow[];
    aggregates: {
        memberActivationCost: { gas: string; usd: string };
        governanceCycleCost: { gas: string; usd: string };
        totalGas: { gas: string; usd: string };
        perMemberEstimates: {
            activation: { gas: string; usd: string };
            cycleShare: { gas: string; usd: string };
            total: { gas: string; usd: string };
        };
    };
    scalability: ExportScalabilityRow[];
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

// ── Esportazione formati tesi ───────────────────────────────────────────────
function csvEscape(value: unknown): string {
    const text = String(value ?? '');
    return `"${text.replace(/"/g, '""')}"`;
}
function toCsv<T extends Record<string, unknown>>(rows: T[], columns: (keyof T)[]): string {
    const header = columns.map(String).join(',');
    const body = rows.map(row => columns.map(column => csvEscape(row[column])).join(','));
    return [header, ...body].join('\n') + '\n';
}
function markdownTable<T extends Record<string, unknown>>(rows: T[], columns: (keyof T)[]): string {
    const header = `| ${columns.map(String).join(' | ')} |`;
    const divider = `| ${columns.map(() => '---').join(' | ')} |`;
    const body = rows.map(row => `| ${columns.map(column => String(row[column] ?? '')).join(' | ')} |`);
    return [header, divider, ...body].join('\n');
}
function summarizeFlow(flow: ExportFlowRow[]) {
    const groups = [
        { phase: 'Join DAO', prefix: 'joinDAO' },
        { phase: 'Delegate', prefix: 'delegate' },
        { phase: 'Register DID', prefix: 'registerDID' },
        { phase: 'Upgrade skill with VC', prefix: 'upgradeSkillWithVC' },
        { phase: 'Propose with topic', prefix: 'proposeWithTopic' },
        { phase: 'Cast vote', prefix: 'castVote' },
        { phase: 'Queue', prefix: 'queue' },
        { phase: 'Execute', prefix: 'execute' },
    ];

    return groups.map(group => {
        const rows = flow.filter(row => row.operation.startsWith(group.prefix));
        const values = rows.map(row => BigInt(row.gasUsed));
        const total = values.reduce((sum, value) => sum + value, 0n);
        const min = values.length > 0 ? values.reduce((a, b) => a < b ? a : b) : 0n;
        const max = values.length > 0 ? values.reduce((a, b) => a > b ? a : b) : 0n;
        const avg = values.length > 0 ? total / BigInt(values.length) : 0n;
        return {
            phase: group.phase,
            calls: String(values.length),
            minGas: min.toString(),
            avgGas: avg.toString(),
            maxGas: max.toString(),
            totalGas: total.toString(),
            totalUsd: toUsd(total),
        };
    }).filter(row => row.calls !== '0');
}
function exportThesisFiles(result: BenchmarkExport) {
    const outDir = path.resolve(__dirname, 'results');
    fs.mkdirSync(outDir, { recursive: true });

    const flowSummary = summarizeFlow(result.flow);
    const aggregateRows = [
        {
            metric: '10 Member Activation Cost',
            gas: result.aggregates.memberActivationCost.gas,
            usd: result.aggregates.memberActivationCost.usd,
            note: 'joinDAO + delegate + registerDID + upgradeSkillWithVC',
        },
        {
            metric: 'Governance Cycle Cost',
            gas: result.aggregates.governanceCycleCost.gas,
            usd: result.aggregates.governanceCycleCost.usd,
            note: 'proposeWithTopic + 10 castVote + queue + execute',
        },
        {
            metric: 'Total Gas',
            gas: result.aggregates.totalGas.gas,
            usd: result.aggregates.totalGas.usd,
            note: 'activation + governance cycle',
        },
        {
            metric: 'Per-Member Activation Estimate',
            gas: result.aggregates.perMemberEstimates.activation.gas,
            usd: result.aggregates.perMemberEstimates.activation.usd,
            note: 'activation / 10 members',
        },
        {
            metric: 'Per-Member Cycle Share Estimate',
            gas: result.aggregates.perMemberEstimates.cycleShare.gas,
            usd: result.aggregates.perMemberEstimates.cycleShare.usd,
            note: 'governance cycle / 10 members',
        },
        {
            metric: 'Per-Member Total Estimate',
            gas: result.aggregates.perMemberEstimates.total.gas,
            usd: result.aggregates.perMemberEstimates.total.usd,
            note: 'total gas / 10 members',
        },
    ];

    fs.writeFileSync(
        path.join(outDir, 'gas-flow.csv'),
        toCsv(result.flow, ['operation', 'gasUsed', 'costEth', 'costUsd']),
        'utf8',
    );
    fs.writeFileSync(
        path.join(outDir, 'gas-flow-summary.csv'),
        toCsv(flowSummary, ['phase', 'calls', 'minGas', 'avgGas', 'maxGas', 'totalGas', 'totalUsd']),
        'utf8',
    );
    fs.writeFileSync(
        path.join(outDir, 'gas-aggregates.csv'),
        toCsv(aggregateRows, ['metric', 'gas', 'usd', 'note']),
        'utf8',
    );
    fs.writeFileSync(
        path.join(outDir, 'gas-scalability.csv'),
        toCsv(result.scalability.map(row => ({
            skillCount: row.skillCount,
            skills: row.skills.join(' + '),
            upgradeGas: row.upgradeGas,
            costEth: row.costEth,
            costUsd: row.costUsd,
        })), ['skillCount', 'skills', 'upgradeGas', 'costEth', 'costUsd']),
        'utf8',
    );

    const report = `# Misurazioni gas - V3 Topic-Based DAO

## Experimental setup

Le misurazioni sono eseguite su Hardhat Network leggendo \`gasUsed\` dalle receipt delle transazioni. Per rendere i costi economici riproducibili nella tesi, la conversione usa valori fissi:

- gas price: ${result.gasPriceGwei} Gwei;
- ETH price: $${result.ethPriceUsd};
- membri: ${result.scenario.members};
- stake per membro: ${result.scenario.stakeEth} ETH;
- pesi: ${result.scenario.weightStakeBp / 100}% stake / ${result.scenario.weightSkillBp / 100}% skill;
- proposta: ${result.scenario.proposalAmountEth} ETH, topic ${result.scenario.proposalTopic}.

## Flow principale

${markdownTable(flowSummary, ['phase', 'calls', 'minGas', 'avgGas', 'maxGas', 'totalGas', 'totalUsd'])}

## Costi aggregati

${markdownTable(aggregateRows, ['metric', 'gas', 'usd', 'note'])}

## Scalabilita' upgradeSkillWithVC

${markdownTable(result.scalability.map(row => ({
        skillCount: String(row.skillCount),
        skills: row.skills.join(' + '),
        upgradeGas: row.upgradeGas,
        costUsd: row.costUsd,
    })), ['skillCount', 'skills', 'upgradeGas', 'costUsd'])}

## Interpretazione sintetica

Il costo di attivazione include le operazioni necessarie affinche' un membro entri nella DAO, attivi il voto ERC20Votes, registri il DID e ottenga il voting power da competenze tramite VC. Il costo del ciclo di governance misura invece la vita di una proposta topic-based: creazione con \`topicId\`, voto dei 10 membri, queue nel Timelock ed execute.

Il micro-benchmark di scalabilita' isola \`upgradeSkillWithVC\` al variare del numero di skill nella credential. L'aumento e' contenuto perche' i checkpoint vengono mantenuti per i 4 topic, mentre il costo marginale deriva soprattutto dal parsing/hashing delle skill presenti nella VC.

## File prodotti

- \`gas-flow.csv\`
- \`gas-flow-summary.csv\`
- \`gas-aggregates.csv\`
- \`gas-scalability.csv\`
- \`gas-grafici.html\`
`;
    fs.writeFileSync(path.join(outDir, 'report.md'), report, 'utf8');
    fs.writeFileSync(path.join(outDir, 'gas-grafici.html'), gasChartsHtml(flowSummary, aggregateRows, result.scalability), 'utf8');
}
function gasChartsHtml(
    flowSummary: ReturnType<typeof summarizeFlow>,
    aggregateRows: { metric: string; gas: string; usd: string; note: string }[],
    scalability: ExportScalabilityRow[],
) {
    return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>Misurazioni gas V3</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #17202a; }
    h1, h2 { margin: 0 0 16px; }
    section { margin-bottom: 42px; }
    .chart { width: 100%; max-width: 1040px; border: 1px solid #d6dde5; border-radius: 8px; padding: 16px; }
    .bar-label { font-size: 12px; fill: #26323f; }
    .axis { stroke: #9aa8b5; stroke-width: 1; }
    .tick { stroke: #c8d2dc; stroke-width: 1; }
    .grid { stroke: #edf1f5; stroke-width: 1; }
    .axis-title { font-size: 12px; font-weight: 700; fill: #26323f; }
  </style>
</head>
<body>
  <h1>Misurazioni gas V3 Topic-Based DAO</h1>
  ${singleBarChart('Gas per fase del flow principale', flowSummary.map(row => ({ label: row.phase, value: Number(row.totalGas), suffix: 'gas' })), '#2f80ed')}
  ${singleBarChart('Costo USD per fase del flow principale', flowSummary.map(row => ({ label: row.phase, value: usdNumber(row.totalUsd), suffix: 'USD' })), '#5b8e7d')}
  ${singleBarChart('Costi aggregati', aggregateRows.slice(0, 3).map(row => ({ label: row.metric, value: Number(row.gas), suffix: 'gas' })), '#2f80ed')}
  ${singleBarChart('Costo USD aggregato', aggregateRows.slice(0, 3).map(row => ({ label: row.metric, value: usdNumber(row.usd), suffix: 'USD' })), '#5b8e7d')}
  ${singleBarChart('Scalabilita reale upgradeSkillWithVC', scalability.map(row => ({ label: `${row.skillCount} skill`, value: Number(row.upgradeGas), suffix: 'gas' })), '#2f80ed')}
  ${singleBarChart('Incremento marginale gas rispetto al caso precedente', marginalRows(scalability).map(row => ({ label: row.label, value: row.value, suffix: 'gas' })), '#c7522a')}
</body>
</html>`;
}
function usdNumber(value: string): number {
    return Number(value.replace('$', '').replace('< .0001', '0.0001'));
}
function marginalRows(scalability: ExportScalabilityRow[]) {
    return scalability.map((row, i) => {
        if (i === 0) return { label: `${row.skillCount} skill`, value: 0 };
        const previous = BigInt(scalability[i - 1].upgradeGas);
        return {
            label: `${scalability[i - 1].skillCount}->${row.skillCount} skill`,
            value: Number(BigInt(row.upgradeGas) - previous),
        };
    }).filter(row => row.value > 0);
}
function singleBarChart(title: string, rows: { label: string; value: number; suffix: string }[], color: string) {
    const width = 1040;
    const height = 88 + rows.length * 38;
    const labelWidth = 230;
    const plotWidth = width - labelWidth - 130;
    const scaleMax = niceAxisMax(Math.max(...rows.map(row => row.value), 1));
    const axisY = 44 + rows.length * 38;
    const bars = rows.map((row, i) => {
        const y = 24 + i * 38;
        const barWidth = (row.value / scaleMax) * plotWidth;
        return `
      <text class="bar-label" x="0" y="${y + 13}">${row.label}</text>
      <rect x="${labelWidth}" y="${y}" width="${barWidth}" height="16" fill="${color}"></rect>
      <text class="bar-label" x="${labelWidth + barWidth + 6}" y="${y + 13}">${formatChartValue(row.value)} ${row.suffix}</text>`;
    }).join('');

    return `<section>
  <h2>${title}</h2>
  <div class="chart">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
      ${bars}
      ${chartAxis(labelWidth, axisY, plotWidth, scaleMax, rows[0]?.suffix ?? '')}
    </svg>
  </div>
</section>`;
}
function formatChartValue(value: number): string {
    if (!Number.isInteger(value)) return value.toLocaleString('it-IT', { maximumFractionDigits: 2 });
    return value.toLocaleString('it-IT');
}
function chartAxis(x: number, y: number, width: number, max: number, suffix: string) {
    const step = niceTickStep(max);
    const ticks = Math.ceil(max / step);
    const lines = Array.from({ length: ticks + 1 }, (_, i) => {
        const value = step * i;
        const tx = x + (value / max) * width;
        return `
      <line class="tick" x1="${tx}" y1="${y - 4}" x2="${tx}" y2="${y + 4}"></line>
      <text class="bar-label" x="${tx}" y="${y + 18}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}">${formatAxisValue(value)}</text>`;
    }).join('');
    return `
      <line class="axis" x1="${x}" y1="${y}" x2="${x + width}" y2="${y}"></line>
      <text class="axis-title" x="${x + width}" y="${y + 36}" text-anchor="end">${suffix}</text>
      ${lines}`;
}
function niceAxisMax(max: number) {
    const step = niceTickStep(max);
    return step * Math.ceil(max / step);
}
function niceTickStep(max: number) {
    const rough = max / 5;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const normalized = rough / magnitude;
    const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return nice * magnitude;
}
function formatAxisValue(value: number): string {
    if (value >= 1_000_000) return (value / 1_000_000).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + 'M';
    if (value >= 1_000) return Math.round(value / 1_000).toLocaleString('it-IT') + 'k';
    if (value >= 100) return Math.round(value).toLocaleString('it-IT');
    return value.toLocaleString('it-IT', { maximumFractionDigits: 2 });
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
        exportThesisFiles(result);
        console.log('  ✓ Thesis outputs written to: ' + path.resolve(__dirname, 'results') + '\n');
    });
});

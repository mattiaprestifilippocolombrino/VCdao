// ============================================================================
//  Bitmap vs no-bitmap scalability benchmark
//
//  Misura upgradeSkillWithVC su mock liberi dai limiti delle 8 skill reali:
//    - #skill per VC: 1, 2, 4, 8, 16, 32, 64
//    - #utenti:       1, 2, 4, 8, 16, 32, 64, con 8 skill per utente
//
//  I due moduli condividono verifica VC, DID e checkpoint; cambia solo lo storage
//  delle skill: bitmap uint256 vs array bytes32[] + mapping anti-duplicato.
// ============================================================================

import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ContractTransactionReceipt, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { EIP712_DOMAIN } from "../helpers/sharedCredentials";

const WEIGHT = 5000n;
const STAKE_ETH = "5";
const ETH_PRICE_USD = 2638.48;
const GAS_PRICE_WEI = 1_032_440_000n;
const GAS_PRICE_GWEI_STR = "1.03244";
const SKILL_SCALE = [1, 2, 4, 8, 16, 32, 64];
const USER_SCALE = [1, 2, 4, 8, 16, 32, 64];
const USER_SCALE_SKILLS = 8;

const VC_TYPES = {
    VerifiableCredential: [
        { name: "issuer", type: "Issuer" },
        { name: "issuanceDate", type: "string" },
        { name: "credentialSubject", type: "CredentialSubject" },
    ],
    Issuer: [
        { name: "id", type: "string" },
    ],
    CredentialSubject: [
        { name: "id", type: "string" },
        { name: "organization", type: "string" },
        { name: "unit", type: "string" },
        { name: "skills", type: "string[]" },
    ],
};

type Variant = "bitmap" | "no-bitmap";

interface SkillRow {
    kind: "skills";
    count: number;
    bitmapGas: bigint;
    noBitmapGas: bigint;
    bitmapEth: string;
    noBitmapEth: string;
    bitmapUsd: string;
    noBitmapUsd: string;
    deltaGas: bigint;
    deltaPct: string;
}

interface UserRow {
    kind: "users";
    count: number;
    bitmapTotalGas: bigint;
    noBitmapTotalGas: bigint;
    bitmapPerUserGas: bigint;
    noBitmapPerUserGas: bigint;
    bitmapTotalEth: string;
    noBitmapTotalEth: string;
    bitmapTotalUsd: string;
    noBitmapTotalUsd: string;
    bitmapPerUserEth: string;
    noBitmapPerUserEth: string;
    bitmapPerUserUsd: string;
    noBitmapPerUserUsd: string;
    deltaPerUserGas: bigint;
    deltaPerUserPct: string;
}

function skills(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `skill-${i}`);
}

function toEth(gas: bigint): string {
    return ethers.formatEther(gas * GAS_PRICE_WEI);
}

function toUsd(gas: bigint): string {
    const v = parseFloat(toEth(gas)) * ETH_PRICE_USD;
    if (v < 0.0001) return "< .0001";
    if (v < 0.01) return "$" + v.toFixed(5);
    if (v < 1) return "$" + v.toFixed(4);
    return "$" + v.toFixed(2);
}

function pct(delta: bigint, base: bigint): string {
    if (base === 0n) return "0.00%";
    return ((Number(delta) / Number(base)) * 100).toFixed(2) + "%";
}

function rec(r: ContractTransactionReceipt): bigint {
    return r.gasUsed;
}

function csvEscape(value: unknown): string {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
}

function toCsv<T extends Record<string, unknown>>(rows: T[], columns: (keyof T)[]): string {
    const header = columns.map(String).join(",");
    const body = rows.map(row => columns.map(column => csvEscape(row[column])).join(","));
    return [header, ...body].join("\n") + "\n";
}

function printSkillRows(rows: SkillRow[]) {
    const hr = "-".repeat(110);
    console.log("\nBITMAP VS NO-BITMAP - SKILL SCALABILITY");
    console.log(`Gas Price: ${GAS_PRICE_GWEI_STR} Gwei | ETH: $${ETH_PRICE_USD}`);
    console.log(hr);
    console.log(
        "#Skills".padEnd(10) +
        " | " + "Bitmap Gas".padStart(12) +
        " | " + "NoBitmap Gas".padStart(12) +
        " | " + "Bitmap ETH".padStart(12) +
        " | " + "NoBitmap ETH".padStart(12) +
        " | " + "Delta Gas".padStart(12) +
        " | " + "Delta".padStart(9) +
        " | " + "Bitmap USD".padStart(10) +
        " | " + "NoBitmap USD".padStart(12),
    );
    console.log(hr);
    for (const row of rows) {
        console.log(
            String(row.count).padEnd(10) +
            " | " + row.bitmapGas.toString().padStart(12) +
            " | " + row.noBitmapGas.toString().padStart(12) +
            " | " + row.bitmapEth.padStart(12) +
            " | " + row.noBitmapEth.padStart(12) +
            " | " + row.deltaGas.toString().padStart(12) +
            " | " + row.deltaPct.padStart(9) +
            " | " + toUsd(row.bitmapGas).padStart(10) +
            " | " + toUsd(row.noBitmapGas).padStart(12),
        );
    }
    console.log(hr);
}

function printUserRows(rows: UserRow[]) {
    const hr = "-".repeat(156);
    console.log(`\nBITMAP VS NO-BITMAP - CUMULATIVE USER COST (${USER_SCALE_SKILLS} skills per user)`);
    console.log("Each row measures N independent upgradeSkillWithVC calls. Per-user = total / N.");
    console.log(hr);
    console.log(
        "#Users".padEnd(10) +
        " | " + "Bitmap Total Gas".padStart(16) +
        " | " + "Bitmap Total ETH".padStart(16) +
        " | " + "Bitmap USD".padStart(10) +
        " | " + "NoBitmap Total Gas".padStart(18) +
        " | " + "NoBitmap Total ETH".padStart(18) +
        " | " + "NoBitmap USD".padStart(12) +
        " | " + "Bitmap/user Gas".padStart(16) +
        " | " + "NoBitmap/user Gas".padStart(18) +
        " | " + "Delta/user".padStart(10) +
        " | " + "Delta".padStart(9),
    );
    console.log(hr);
    for (const row of rows) {
        console.log(
            String(row.count).padEnd(10) +
            " | " + row.bitmapTotalGas.toString().padStart(16) +
            " | " + row.bitmapTotalEth.padStart(16) +
            " | " + row.bitmapTotalUsd.padStart(10) +
            " | " + row.noBitmapTotalGas.toString().padStart(18) +
            " | " + row.noBitmapTotalEth.padStart(18) +
            " | " + row.noBitmapTotalUsd.padStart(12) +
            " | " + row.bitmapPerUserGas.toString().padStart(16) +
            " | " + row.noBitmapPerUserGas.toString().padStart(18) +
            " | " + row.deltaPerUserGas.toString().padStart(10) +
            " | " + row.deltaPerUserPct.padStart(9),
        );
    }
    console.log(hr);
}

async function deployFixture() {
    const signers = await ethers.getSigners();
    const deployer = signers[0];
    const issuer = signers[2];

    const TL = await ethers.getContractFactory("TimelockController");
    const timelock = await TL.deploy(3600, [], [], deployer.address);
    await timelock.waitForDeployment();

    const TK = await ethers.getContractFactory("GovernanceToken");
    const token = await TK.deploy(await timelock.getAddress(), WEIGHT, WEIGHT);
    await token.waitForDeployment();

    const TR = await ethers.getContractFactory("Treasury");
    const treasury = await TR.deploy(await timelock.getAddress());
    await treasury.waitForDeployment();
    await token.setTreasury(await treasury.getAddress());

    const SC = await ethers.getContractFactory("MockFlatSkillCalculator");
    const calculator = await SC.deploy();
    await calculator.waitForDeployment();

    const Bitmap = await ethers.getContractFactory("MockBitmapGovernanceSkill");
    const bitmap = await Bitmap.deploy(await token.getAddress(), WEIGHT, await calculator.getAddress());
    await bitmap.waitForDeployment();
    await bitmap.setTrustedIssuer(issuer.address);

    const NoBitmap = await ethers.getContractFactory("MockNoBitmapGovernanceSkill");
    const noBitmap = await NoBitmap.deploy(await token.getAddress(), WEIGHT, await calculator.getAddress());
    await noBitmap.waitForDeployment();
    await noBitmap.setTrustedIssuer(issuer.address);

    return { deployer, issuer, token, bitmap, noBitmap };
}

async function buildVC(issuer: HardhatEthersSigner, holder: string, skillNames: string[]) {
    const vcData = {
        issuer: { id: "did:ethr:" + issuer.address },
        issuanceDate: "2025-01-01T00:00:00Z",
        credentialSubject: {
            id: "did:ethr:" + holder,
            organization: "BenchmarkOrg",
            unit: "Scalability",
            skills: skillNames,
        },
    };
    const sig = await issuer.signTypedData(EIP712_DOMAIN as any, VC_TYPES as any, vcData);
    return { vcData, sig };
}

async function freshMember(deployer: HardhatEthersSigner): Promise<Wallet> {
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: wallet.address, value: ethers.parseEther("20") });
    return wallet;
}

async function prepareMember(
    deployer: HardhatEthersSigner,
    token: any,
    skillModule: any,
    issuer: HardhatEthersSigner,
    skillNames: string[],
) {
    const member = await freshMember(deployer);
    await token.connect(member).joinDAO({ value: ethers.parseEther(STAKE_ETH) });
    await token.connect(member).delegate(member.address);
    const { vcData, sig } = await buildVC(issuer, member.address, skillNames);
    await skillModule.connect(member).registerDID(vcData.credentialSubject.id);
    return { member, vcData, sig };
}

async function measureOneUpgrade(variant: Variant, skillCount: number): Promise<bigint> {
    const ctx = await loadFixture(deployFixture);
    const skillModule = variant === "bitmap" ? ctx.bitmap : ctx.noBitmap;
    const prepared = await prepareMember(ctx.deployer, ctx.token, skillModule, ctx.issuer, skills(skillCount));
    const r = await (await skillModule.connect(prepared.member).upgradeSkillWithVC(prepared.vcData, prepared.sig)).wait();
    return rec(r!);
}

async function measureUsers(variant: Variant, userCount: number): Promise<bigint> {
    const ctx = await loadFixture(deployFixture);
    const skillModule = variant === "bitmap" ? ctx.bitmap : ctx.noBitmap;
    let total = 0n;
    for (let i = 0; i < userCount; i++) {
        const prepared = await prepareMember(ctx.deployer, ctx.token, skillModule, ctx.issuer, skills(USER_SCALE_SKILLS));
        const r = await (await skillModule.connect(prepared.member).upgradeSkillWithVC(prepared.vcData, prepared.sig)).wait();
        total += rec(r!);
    }
    return total;
}

describe("Gas scalability - bitmap vs no-bitmap mocks", function () {
    this.timeout(180_000);

    const skillRows: SkillRow[] = [];
    const userRows: UserRow[] = [];

    it("measures powers of two skill counts up to 64", async function () {
        for (const count of SKILL_SCALE) {
            const bitmapGas = await measureOneUpgrade("bitmap", count);
            const noBitmapGas = await measureOneUpgrade("no-bitmap", count);
            const deltaGas = noBitmapGas - bitmapGas;
            skillRows.push({
                kind: "skills",
                count,
                bitmapGas,
                noBitmapGas,
                bitmapEth: toEth(bitmapGas),
                noBitmapEth: toEth(noBitmapGas),
                bitmapUsd: toUsd(bitmapGas),
                noBitmapUsd: toUsd(noBitmapGas),
                deltaGas,
                deltaPct: pct(deltaGas, bitmapGas),
            });
        }
        printSkillRows(skillRows);
    });

    it(`measures powers of two users up to 64 with ${USER_SCALE_SKILLS} skills each`, async function () {
        for (const count of USER_SCALE) {
            const bitmapTotalGas = await measureUsers("bitmap", count);
            const noBitmapTotalGas = await measureUsers("no-bitmap", count);
            const bitmapPerUserGas = bitmapTotalGas / BigInt(count);
            const noBitmapPerUserGas = noBitmapTotalGas / BigInt(count);
            const deltaPerUserGas = noBitmapPerUserGas - bitmapPerUserGas;
            userRows.push({
                kind: "users",
                count,
                bitmapTotalGas,
                noBitmapTotalGas,
                bitmapPerUserGas,
                noBitmapPerUserGas,
                bitmapTotalEth: toEth(bitmapTotalGas),
                noBitmapTotalEth: toEth(noBitmapTotalGas),
                bitmapTotalUsd: toUsd(bitmapTotalGas),
                noBitmapTotalUsd: toUsd(noBitmapTotalGas),
                bitmapPerUserEth: toEth(bitmapPerUserGas),
                noBitmapPerUserEth: toEth(noBitmapPerUserGas),
                bitmapPerUserUsd: toUsd(bitmapPerUserGas),
                noBitmapPerUserUsd: toUsd(noBitmapPerUserGas),
                deltaPerUserGas,
                deltaPerUserPct: pct(deltaPerUserGas, bitmapPerUserGas),
            });
        }
        printUserRows(userRows);
    });

    after(function () {
        if (skillRows.length === 0 && userRows.length === 0) return;

        const outDir = path.resolve(__dirname, "results");
        fs.mkdirSync(outDir, { recursive: true });

        fs.writeFileSync(
            path.join(outDir, "bitmap-vs-nobitmap-skills.csv"),
            toCsv(skillRows.map(row => ({
                count: row.count,
                bitmapGas: row.bitmapGas.toString(),
                noBitmapGas: row.noBitmapGas.toString(),
                bitmapEth: row.bitmapEth,
                noBitmapEth: row.noBitmapEth,
                bitmapUsd: row.bitmapUsd,
                noBitmapUsd: row.noBitmapUsd,
                deltaGas: row.deltaGas.toString(),
                deltaPct: row.deltaPct,
            })), ["count", "bitmapGas", "noBitmapGas", "bitmapEth", "noBitmapEth", "bitmapUsd", "noBitmapUsd", "deltaGas", "deltaPct"]),
            "utf8",
        );

        fs.writeFileSync(
            path.join(outDir, "bitmap-vs-nobitmap-users.csv"),
            toCsv(userRows.map(row => ({
                count: row.count,
                bitmapTotalGas: row.bitmapTotalGas.toString(),
                noBitmapTotalGas: row.noBitmapTotalGas.toString(),
                bitmapTotalEth: row.bitmapTotalEth,
                noBitmapTotalEth: row.noBitmapTotalEth,
                bitmapTotalUsd: row.bitmapTotalUsd,
                noBitmapTotalUsd: row.noBitmapTotalUsd,
                bitmapPerUserGas: row.bitmapPerUserGas.toString(),
                noBitmapPerUserGas: row.noBitmapPerUserGas.toString(),
                bitmapPerUserEth: row.bitmapPerUserEth,
                noBitmapPerUserEth: row.noBitmapPerUserEth,
                bitmapPerUserUsd: row.bitmapPerUserUsd,
                noBitmapPerUserUsd: row.noBitmapPerUserUsd,
                deltaPerUserGas: row.deltaPerUserGas.toString(),
                deltaPerUserPct: row.deltaPerUserPct,
            })), [
                "count",
                "bitmapTotalGas",
                "noBitmapTotalGas",
                "bitmapTotalEth",
                "noBitmapTotalEth",
                "bitmapTotalUsd",
                "noBitmapTotalUsd",
                "bitmapPerUserGas",
                "noBitmapPerUserGas",
                "bitmapPerUserEth",
                "noBitmapPerUserEth",
                "bitmapPerUserUsd",
                "noBitmapPerUserUsd",
                "deltaPerUserGas",
                "deltaPerUserPct",
            ]),
            "utf8",
        );

        fs.writeFileSync(path.join(outDir, "bitmap-vs-nobitmap-report.md"), markdownReport(skillRows, userRows), "utf8");
        fs.writeFileSync(path.join(outDir, "bitmap-vs-nobitmap-grafici.html"), chartsHtml(skillRows, userRows), "utf8");
        console.log("\nCSV written to: " + outDir + "\n");
    });
});

function markdownTable<T extends Record<string, unknown>>(rows: T[], columns: (keyof T)[]): string {
    const header = `| ${columns.map(String).join(" | ")} |`;
    const divider = `| ${columns.map(() => "---").join(" | ")} |`;
    const body = rows.map(row => `| ${columns.map(column => String(row[column] ?? "")).join(" | ")} |`);
    return [header, divider, ...body].join("\n");
}

function markdownReport(skillRows: SkillRow[], userRows: UserRow[]) {
    return `# Bitmap vs no-bitmap - scalabilita gas

## Setup sperimentale

Le misure isolano \`upgradeSkillWithVC\` dopo il bootstrap non misurato del membro: \`joinDAO\`, \`delegate\`, \`registerDID\`. I contratti mock mantengono verifica EIP-712, DID e checkpoint per 4 topic; varia solo la rappresentazione delle skill:

- bitmap: un \`uint256\` per membro;
- no-bitmap: \`bytes32[]\` piu' mapping anti-duplicato;
- calculator: score costante pari a 100 per ogni topic, per non misurare la matrice di scoring.

Conversione economica: ${GAS_PRICE_GWEI_STR} Gwei, ETH $${ETH_PRICE_USD}.

## Scalabilita per numero di skill

${markdownTable(skillRows.map(row => ({
        skills: row.count,
        bitmapGas: row.bitmapGas,
        bitmapEth: row.bitmapEth,
        bitmapUsd: row.bitmapUsd,
        noBitmapGas: row.noBitmapGas,
        noBitmapEth: row.noBitmapEth,
        noBitmapUsd: row.noBitmapUsd,
        deltaGas: row.deltaGas,
        deltaPct: row.deltaPct,
    })), ["skills", "bitmapGas", "bitmapEth", "bitmapUsd", "noBitmapGas", "noBitmapEth", "noBitmapUsd", "deltaGas", "deltaPct"])}

## Scalabilita per numero di utenti

Ogni riga misura il costo cumulativo di N chiamate indipendenti a \`upgradeSkillWithVC\`, una per utente, con ${USER_SCALE_SKILLS} skill per VC. Il bootstrap del membro (\`joinDAO\`, \`delegate\`, \`registerDID\`) non e' incluso nel totale: serve solo a rendere valida la chiamata misurata.

Le colonne \`PerUser\` non sono una nuova transazione: sono il totale diviso per N. Servono a verificare se il costo medio per membro resta stabile quando cresce la popolazione.

${markdownTable(userRows.map(row => ({
        users: row.count,
        bitmapTotalGas: row.bitmapTotalGas,
        bitmapTotalEth: row.bitmapTotalEth,
        bitmapTotalUsd: row.bitmapTotalUsd,
        noBitmapTotalGas: row.noBitmapTotalGas,
        noBitmapTotalEth: row.noBitmapTotalEth,
        noBitmapTotalUsd: row.noBitmapTotalUsd,
        bitmapPerUserGas: row.bitmapPerUserGas,
        bitmapPerUserEth: row.bitmapPerUserEth,
        bitmapPerUserUsd: row.bitmapPerUserUsd,
        noBitmapPerUserGas: row.noBitmapPerUserGas,
        noBitmapPerUserEth: row.noBitmapPerUserEth,
        noBitmapPerUserUsd: row.noBitmapPerUserUsd,
        deltaPerUserGas: row.deltaPerUserGas,
        deltaPerUserPct: row.deltaPerUserPct,
    })), [
        "users",
        "bitmapTotalGas",
        "bitmapTotalEth",
        "bitmapTotalUsd",
        "noBitmapTotalGas",
        "noBitmapTotalEth",
        "noBitmapTotalUsd",
        "bitmapPerUserGas",
        "bitmapPerUserEth",
        "bitmapPerUserUsd",
        "noBitmapPerUserGas",
        "noBitmapPerUserEth",
        "noBitmapPerUserUsd",
        "deltaPerUserGas",
        "deltaPerUserPct",
    ])}

## Lettura sintetica

La bitmap mantiene una crescita molto piu' contenuta al crescere del numero di skill perche' comprime la membership delle competenze in un solo \`uint256\`. Il modello no-bitmap paga storage separato per ogni nuova skill e il delta cresce con la cardinalita' della VC.

La misura utenti e' quasi lineare sul totale perche' ogni utente esegue una transazione distinta. Il valore per utente mostra il costo operativo atteso di un singolo nuovo membro con ${USER_SCALE_SKILLS} skill, mentre il totale mostra il costo cumulativo per popolare una DAO con N membri gia' certificati.
`;
}

function chartsHtml(skillRows: SkillRow[], userRows: UserRow[]) {
    return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>Bitmap vs no-bitmap - scalabilita gas</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #17202a; }
    h1, h2 { margin: 0 0 16px; }
    section { margin-bottom: 42px; }
    .chart { width: 100%; max-width: 1120px; border: 1px solid #d6dde5; border-radius: 8px; padding: 16px; overflow-x: auto; }
    .label { font-size: 12px; fill: #26323f; }
    .axis { stroke: #9aa8b5; stroke-width: 1; }
    .tick { stroke: #c8d2dc; stroke-width: 1; }
    .grid { stroke: #edf1f5; stroke-width: 1; }
    .axis-title { font-size: 12px; font-weight: 700; fill: #26323f; }
    .legend { display: flex; gap: 18px; margin: 0 0 12px; font-size: 13px; }
    .swatch { display: inline-block; width: 12px; height: 12px; margin-right: 6px; vertical-align: -1px; }
  </style>
</head>
<body>
  <h1>Bitmap vs no-bitmap - scalabilita gas</h1>
  ${groupedBarChart("Gas per numero di skill", skillRows.map(row => ({
        label: `${row.count} skill`,
        bitmap: Number(row.bitmapGas),
        noBitmap: Number(row.noBitmapGas),
    })), "gas", true)}
  ${groupedBarChart("Costo USD per numero di skill", skillRows.map(row => ({
        label: `${row.count} skill`,
        bitmap: usdNumber(row.bitmapUsd),
        noBitmap: usdNumber(row.noBitmapUsd),
    })), "USD", true)}
  ${singleBarChart("Delta no-bitmap vs bitmap per numero di skill", skillRows.map(row => ({
        label: `${row.count} skill`,
        value: Number(row.deltaGas),
        suffix: "gas",
    })), "#c7522a")}
  ${groupedBarChart(`Gas totale cumulativo per numero di utenti (${USER_SCALE_SKILLS} skill/utente)`, userRows.map(row => ({
        label: `${row.count} utenti`,
        bitmap: Number(row.bitmapTotalGas),
        noBitmap: Number(row.noBitmapTotalGas),
    })), "gas", true)}
  ${groupedBarChart(`Gas per utente: totale / N (${USER_SCALE_SKILLS} skill/utente)`, userRows.map(row => ({
        label: `${row.count} utenti`,
        bitmap: Number(row.bitmapPerUserGas),
        noBitmap: Number(row.noBitmapPerUserGas),
    })), "gas", true)}
  ${groupedBarChart(`Costo totale cumulativo in USD (${USER_SCALE_SKILLS} skill/utente)`, userRows.map(row => ({
        label: `${row.count} utenti`,
        bitmap: usdNumber(row.bitmapTotalUsd),
        noBitmap: usdNumber(row.noBitmapTotalUsd),
    })), "USD", true)}
</body>
</html>`;
}

function usdNumber(value: string): number {
    return Number(value.replace("$", "").replace("< .0001", "0.0001"));
}

function groupedBarChart(title: string, rows: { label: string; bitmap: number; noBitmap: number }[], suffix: string, showAxis = false) {
    const width = 1120;
    const height = 92 + rows.length * 46;
    const labelWidth = 150;
    const plotWidth = width - labelWidth - 160;
    const dataMax = Math.max(...rows.flatMap(row => [row.bitmap, row.noBitmap]), 1);
    const scaleMax = niceAxisMax(dataMax);
    const axisY = 52 + rows.length * 46;
    const axis = showAxis ? chartAxis(labelWidth, axisY, plotWidth, scaleMax, suffix) : `<line class="axis" x1="${labelWidth}" y1="${axisY}" x2="${labelWidth + plotWidth}" y2="${axisY}"></line>`;
    const bars = rows.map((row, i) => {
        const y = 28 + i * 46;
        const bitmapWidth = (row.bitmap / scaleMax) * plotWidth;
        const noBitmapWidth = (row.noBitmap / scaleMax) * plotWidth;
        return `
      <text class="label" x="0" y="${y + 20}">${row.label}</text>
      <rect x="${labelWidth}" y="${y}" width="${bitmapWidth}" height="14" fill="#2f80ed"></rect>
      <rect x="${labelWidth}" y="${y + 18}" width="${noBitmapWidth}" height="14" fill="#c7522a"></rect>
      <text class="label" x="${labelWidth + bitmapWidth + 6}" y="${y + 11}">${row.bitmap.toLocaleString("it-IT")} ${suffix}</text>
      <text class="label" x="${labelWidth + noBitmapWidth + 6}" y="${y + 29}">${row.noBitmap.toLocaleString("it-IT")} ${suffix}</text>`;
    }).join("");

    return `<section>
  <h2>${title}</h2>
  <div class="legend"><span><span class="swatch" style="background:#2f80ed"></span>Bitmap</span><span><span class="swatch" style="background:#c7522a"></span>No-bitmap</span></div>
  <div class="chart">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
      ${axis}
      ${bars}
    </svg>
  </div>
</section>`;
}

function singleBarChart(title: string, rows: { label: string; value: number; suffix: string }[], color: string) {
    const width = 1120;
    const height = 88 + rows.length * 38;
    const labelWidth = 150;
    const plotWidth = width - labelWidth - 160;
    const scaleMax = niceAxisMax(Math.max(...rows.map(row => row.value), 1));
    const axisY = 44 + rows.length * 38;
    const bars = rows.map((row, i) => {
        const y = 24 + i * 38;
        const barWidth = (row.value / scaleMax) * plotWidth;
        return `
      <text class="label" x="0" y="${y + 13}">${row.label}</text>
      <rect x="${labelWidth}" y="${y}" width="${barWidth}" height="16" fill="${color}"></rect>
      <text class="label" x="${labelWidth + barWidth + 6}" y="${y + 13}">${row.value.toLocaleString("it-IT")} ${row.suffix}</text>`;
    }).join("");

    return `<section>
  <h2>${title}</h2>
  <div class="chart">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
      ${bars}
      ${chartAxis(labelWidth, axisY, plotWidth, scaleMax, rows[0]?.suffix ?? "")}
    </svg>
  </div>
</section>`;
}

function chartAxis(x: number, y: number, width: number, max: number, suffix: string) {
    const step = niceTickStep(max);
    const ticks = Math.ceil(max / step);
    const lines = Array.from({ length: ticks + 1 }, (_, i) => {
        const value = step * i;
        const tx = x + (value / max) * width;
        return `
      <line class="grid" x1="${tx}" y1="18" x2="${tx}" y2="${y}"></line>
      <line class="tick" x1="${tx}" y1="${y - 4}" x2="${tx}" y2="${y + 4}"></line>
      <text class="label" x="${tx}" y="${y + 18}" text-anchor="${i === 0 ? "start" : i === ticks ? "end" : "middle"}">${formatAxisValue(value)}</text>`;
    }).join("");
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

function formatAxisValue(value: number) {
    if (value >= 1_000_000) return (value / 1_000_000).toLocaleString("it-IT", { maximumFractionDigits: 1 }) + "M";
    if (value >= 1_000) return Math.round(value / 1_000).toLocaleString("it-IT") + "k";
    if (value >= 100) return Math.round(value).toLocaleString("it-IT");
    return value.toLocaleString("it-IT", { maximumFractionDigits: 2 });
}

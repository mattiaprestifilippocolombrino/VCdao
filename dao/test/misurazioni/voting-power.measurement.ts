import { ethers, network } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
    GovernanceSkill,
    GovernanceToken,
    MyGovernor,
    TimelockController,
    Treasury,
    SkillCalculator,
} from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const OUT_DIR = join(__dirname, "results");
const TOPIC_AI_DATA = 0;
const TOPIC_CLOUD_CYBERSECURITY = 1;
const TOPIC_FINTECH_BLOCKCHAIN = 2;
const TOPIC_ENTERPRISE_SOFTWARE = 3;

type MemberProfile = {
    label: string;
    stakeEth: string;
    skills: string[];
};

type MeasurementRow = {
    user: string;
    stake: number;
    skills: string;
    skillScoreAI: number;
    skillScoreFinTech: number;
    tokenOnlyVP?: number;
    stake75Skill25VP?: number;
    hybridVP?: number;
    stake25Skill75VP?: number;
    skillOnlyVP?: number;
    diff?: number;
    aiVP?: number;
    fintechVP?: number;
    aiDataVP?: number;
    cloudCyberVP?: number;
    fintechBlockchainVP?: number;
    enterpriseSoftwareVP?: number;
    shareTokenOnly?: number;
    share75_25?: number;
    shareHybrid?: number;
    share25_75?: number;
    shareSkillOnly?: number;
    weightStake?: string;
    weightSkill?: string;
    whaleShare?: number;
    expertShare?: number;
};

type Deployment = {
    token: GovernanceToken;
    skillModule: GovernanceSkill;
    governor: MyGovernor;
    timelock: TimelockController;
    calculator: SkillCalculator;
    deployer: HardhatEthersSigner;
    members: HardhatEthersSigner[];
};

const mainProfiles: MemberProfile[] = [
    { label: "U1", stakeEth: "100", skills: ["blockchain"] },
    { label: "U2", stakeEth: "20", skills: ["machineLearning", "dataEngineering"] },
    { label: "U3", stakeEth: "20", skills: ["blockchain", "startupFinance"] },
    { label: "U4", stakeEth: "40", skills: ["softwareArchitecture", "cloudArchitecture"] },
    { label: "U5", stakeEth: "30", skills: ["cyberSecurity", "cloudArchitecture"] },
    { label: "U6", stakeEth: "15", skills: ["machineLearning"] },
    { label: "U7", stakeEth: "15", skills: ["dataEngineering"] },
    { label: "U8", stakeEth: "10", skills: ["startupFinance"] },
    { label: "U9", stakeEth: "10", skills: ["distributedSystems"] },
    { label: "U10", stakeEth: "5", skills: [] },
];

const whaleProfiles: MemberProfile[] = [
    { label: "Whale", stakeEth: "60", skills: ["blockchain"] },
    { label: "Expert A", stakeEth: "10", skills: ["machineLearning", "dataEngineering"] },
    { label: "Expert B", stakeEth: "10", skills: ["machineLearning"] },
    { label: "Expert C", stakeEth: "5", skills: ["dataEngineering", "distributedSystems"] },
    { label: "Other 1", stakeEth: "5", skills: ["softwareArchitecture"] },
    { label: "Other 2", stakeEth: "4", skills: ["cloudArchitecture"] },
    { label: "Other 3", stakeEth: "3", skills: ["startupFinance"] },
    { label: "Other 4", stakeEth: "2", skills: ["cyberSecurity"] },
    { label: "Other 5", stakeEth: "1", skills: [] },
    { label: "Other 6", stakeEth: "1", skills: ["blockchain"] },
];

const topicProfiles: MemberProfile[] = [
    { label: "AI/Data expert", stakeEth: "40", skills: ["machineLearning", "dataEngineering"] },
    { label: "Cloud/Security expert", stakeEth: "40", skills: ["cyberSecurity", "cloudArchitecture"] },
    { label: "FinTech/Web3 expert", stakeEth: "40", skills: ["blockchain", "startupFinance"] },
    { label: "Enterprise architect", stakeEth: "40", skills: ["softwareArchitecture", "cloudArchitecture"] },
    { label: "Cross-domain engineer", stakeEth: "40", skills: ["distributedSystems", "cloudArchitecture"] },
    { label: "No certified skill", stakeEth: "40", skills: [] },
];

async function deployDAO(weightStakeBp: bigint, weightSkillBp: bigint): Promise<Deployment> {
    const signers = await ethers.getSigners();
    const [deployer, ...members] = signers;
    const votingDelay = 1;
    const votingPeriod = 50;
    const timelockDelay = 3600;

    const Timelock = await ethers.getContractFactory("TimelockController");
    const timelock = await Timelock.deploy(timelockDelay, [], [], deployer.address);
    await timelock.waitForDeployment();

    const Token = await ethers.getContractFactory("GovernanceToken");
    const token = await Token.deploy(await timelock.getAddress(), weightSkillBp, weightStakeBp);
    await token.waitForDeployment();

    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    const treasury: Treasury = await TreasuryFactory.deploy(await timelock.getAddress());
    await treasury.waitForDeployment();
    await token.setTreasury(await treasury.getAddress());

    const Calculator = await ethers.getContractFactory("SkillCalculator");
    const calculator: SkillCalculator = await Calculator.deploy();
    await calculator.waitForDeployment();

    const Skill = await ethers.getContractFactory("GovernanceSkill");
    const skillModule = await Skill.deploy(
        await token.getAddress(),
        await timelock.getAddress(),
        weightSkillBp,
        await calculator.getAddress()
    );
    await skillModule.waitForDeployment();

    const Governor = await ethers.getContractFactory("MyGovernor");
    const governor = await Governor.deploy(
        await token.getAddress(),
        await skillModule.getAddress(),
        await timelock.getAddress(),
        votingDelay,
        votingPeriod,
        0,
        20,
        70
    );
    await governor.waitForDeployment();

    const governorAddress = await governor.getAddress();
    await timelock.grantRole(await timelock.PROPOSER_ROLE(), governorAddress);
    await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
    await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);

    return { token, skillModule, governor, timelock, calculator, deployer, members };
}

async function asTimelock(
    timelock: TimelockController,
    funder: HardhatEthersSigner,
    fn: (signer: HardhatEthersSigner) => Promise<unknown>
) {
    const timelockAddress = await timelock.getAddress();
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [timelockAddress] });
    await funder.sendTransaction({ to: timelockAddress, value: ethers.parseEther("1") });
    const signer = await ethers.getSigner(timelockAddress);
    try {
        await fn(signer);
    } finally {
        await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [timelockAddress] });
    }
}

async function setupProfiles(deployment: Deployment, profiles: MemberProfile[]) {
    for (let i = 0; i < profiles.length; i++) {
        const signer = deployment.members[i];
        await deployment.token.connect(signer).joinDAO({ value: ethers.parseEther(profiles[i].stakeEth) });
        await deployment.token.connect(signer).delegate(signer.address);
        if (profiles[i].skills.length > 0) {
            await asTimelock(deployment.timelock, deployment.deployer, (timelockSigner) =>
                deployment.skillModule
                    .connect(timelockSigner)
                    .upgradeSkill(signer.address, profiles[i].skills, ethers.id(`${profiles[i].label}-skills`))
            );
        }
    }
    await mine(1);
}

async function score(calculator: SkillCalculator, topicId: number, skills: string[]) {
    const scores = await calculator.calculateAllVP(skills.map((skill) => ethers.id(skill)));
    return Number(scores[topicId]);
}

async function vp(deployment: Deployment, signer: HardhatEthersSigner, topicId: number, blockNumber: number) {
    const encodedTopic = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [topicId]);
    return Number(ethers.formatEther(await deployment.governor.getVotesWithParams(signer.address, blockNumber, encodedTopic)));
}

function round(value: number, decimals = 2) {
    return Number(value.toFixed(decimals));
}

function shareRows(rows: MeasurementRow[], field: keyof MeasurementRow) {
    const total = rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0);
    return rows.map((row) => round((Number(row[field] ?? 0) / total) * 100));
}

function toCsv(rows: MeasurementRow[], columns: (keyof MeasurementRow)[]) {
    const header = columns.join(",");
    const body = rows.map((row) =>
        columns.map((column) => JSON.stringify(row[column] ?? "")).join(",")
    );
    return [header, ...body].join("\n") + "\n";
}

function writeBarChartHtml(
    experiment1: MeasurementRow[],
    experiment2: MeasurementRow[],
    experiment3: MeasurementRow[],
    sensitivity: MeasurementRow[]
) {
    const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>Misurazioni voting power</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #17202a; }
    h1, h2 { margin: 0 0 16px; }
    p { margin: 0 0 10px; line-height: 1.45; }
    section { margin-bottom: 42px; }
    .context, .chart { width: 100%; max-width: 1120px; border: 1px solid #d6dde5; border-radius: 8px; padding: 16px; box-sizing: border-box; }
    .context { margin: 0 0 12px; background: #f8fafc; }
    .context-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 24px; }
    .metric { font-size: 13px; }
    .metric b { display: inline-block; min-width: 130px; color: #26323f; }
    table { border-collapse: collapse; width: 100%; margin-top: 10px; font-size: 12px; }
    th, td { border-bottom: 1px solid #d6dde5; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { color: #26323f; background: #eef3f8; }
    .bar-label { font-size: 12px; fill: #26323f; }
    .axis { stroke: #9aa8b5; stroke-width: 1; }
    .tick { stroke: #c8d2dc; stroke-width: 1; }
    .axis-title { font-size: 12px; font-weight: 700; fill: #26323f; }
  </style>
</head>
<body>
  <h1>Misurazioni voting power</h1>
  ${globalContext()}
  ${multiBarChart("Grafico 1 - Voting power per configurazione", experiment1, [
    { field: "tokenOnlyVP", label: "100/0", color: "#2f80ed" },
    { field: "stake75Skill25VP", label: "75/25", color: "#00a6a6" },
    { field: "hybridVP", label: "50/50", color: "#27ae60" },
    { field: "stake25Skill75VP", label: "25/75", color: "#f2994a" },
    { field: "skillOnlyVP", label: "0/100", color: "#9b51e0" },
  ], "VP", experimentContext(
    "Input esperimento 1",
    "Dataset principale con 10 membri, stake eterogenei e skill eterogenee. Topic fissato su AI & Data; varia solo il rapporto weightStake/weightSkill.",
    mainProfiles,
    [
      ["Topic", "AI & Data"],
      ["Pesi confrontati", "100/0, 75/25, 50/50, 25/75, 0/100"],
      ["Lettura", "Mostra come il VP individuale si sposta dalla ricchezza depositata alla pertinenza delle competenze."],
    ],
  ))}
  ${multiBarChart("Grafico 2 - Share del voting power", experiment2, [
    { field: "shareTokenOnly", label: "100/0", color: "#2f80ed" },
    { field: "share75_25", label: "75/25", color: "#00a6a6" },
    { field: "shareHybrid", label: "50/50", color: "#27ae60" },
    { field: "share25_75", label: "25/75", color: "#f2994a" },
    { field: "shareSkillOnly", label: "0/100", color: "#9b51e0" },
  ], "%", experimentContext(
    "Input esperimento 2",
    "Scenario whale vs minoranza esperta: un membro ha molto stake ma bassa pertinenza topic; tre esperti hanno poco stake ma skill AI/Data forti.",
    whaleProfiles,
    [
      ["Topic", "AI & Data"],
      ["Whale", "60 ETH, skill blockchain, score AI/Data basso"],
      ["Expert minority", "Expert A/B/C, stake aggregato 25 ETH, competenze AI/Data piu' pertinenti"],
      ["Lettura", "Misura la redistribuzione della quota di potere quando aumenta il peso delle skill."],
    ],
  ))}
  ${multiBarChart("Grafico 3 - Sensitivity al topic", experiment3, [
    { field: "aiDataVP", label: "AI & Data", color: "#2f80ed" },
    { field: "cloudCyberVP", label: "Cloud & Cyber", color: "#00a6a6" },
    { field: "fintechBlockchainVP", label: "FinTech & Blockchain", color: "#27ae60" },
    { field: "enterpriseSoftwareVP", label: "Enterprise Software", color: "#f2994a" },
  ], "VP", experimentContext(
    "Input esperimento 3",
    "Profili con stesso stake e competenze specialistiche. Il peso resta 50/50; cambia solo il topic letto dal Governor.",
    topicProfiles,
    [
      ["Stake", "40 ETH per tutti i profili"],
      ["Pesi", "50% stake / 50% skill"],
      ["Topic confrontati", "AI & Data, Cloud & Cybersecurity, FinTech & Blockchain, Enterprise Software"],
      ["Controllo", "Il profilo senza skill resta a 20 VP su tutti i topic, pari alla sola componente stake al 50%."],
    ],
  ))}
  ${multiBarChart("Grafico 4 - Sensitivity dei pesi: whale vs esperti", sensitivity, [
    { field: "whaleShare", label: "Whale", color: "#c7522a" },
    { field: "expertShare", label: "Expert A+B+C", color: "#2f80ed" },
  ], "%", experimentContext(
    "Input sensitivity analysis",
    "Stesso dataset whale/expert e stesso topic AI & Data. Il grafico condensa la quota del whale e la quota aggregata dei tre esperti al variare dei pesi.",
    whaleProfiles,
    [
      ["Topic", "AI & Data"],
      ["Pesi", "100/0, 75/25, 50/50, 25/75, 0/100"],
      ["Output", "Quota percentuale sul voting power totale del gruppo."],
    ],
  ))}
</body>
</html>`;
    writeFileSync(join(OUT_DIR, "grafici.html"), html);
}

function globalContext() {
    return `<section>
  <h2>Contesto comune</h2>
  <div class="context">
    <div class="context-grid">
      <div class="metric"><b>Ambiente</b>Hardhat Network, contratti deployati nel test</div>
      <div class="metric"><b>Unita'</b>Voting power espresso in COMP normalizzati da wei</div>
      <div class="metric"><b>Formula</b>VP = VP_stake(account) + VP_skill(account, topic)</div>
      <div class="metric"><b>Skill VP</b>score topic-specifico x weightSkill x 1e18 / 10.000</div>
      <div class="metric"><b>Stake VP</b>deposito ETH convertito in token voting power secondo weightStake</div>
      <div class="metric"><b>Scopo</b>Isolare l'effetto di pesi, competenze e topic sul potere di voto</div>
    </div>
  </div>
</section>`;
}

function experimentContext(
    title: string,
    description: string,
    profiles: MemberProfile[],
    facts: [string, string][]
) {
    const factRows = facts.map(([label, value]) => `<div class="metric"><b>${label}</b>${value}</div>`).join("");
    const profileRows = profiles.map((profile) => `
      <tr>
        <td>${profile.label}</td>
        <td>${profile.stakeEth}</td>
        <td>${profile.skills.length === 0 ? "nessuna" : profile.skills.join(" + ")}</td>
      </tr>`).join("");
    return `<div class="context">
    <h3>${title}</h3>
    <p>${description}</p>
    <div class="context-grid">${factRows}</div>
    <table>
      <thead><tr><th>Profilo</th><th>Stake ETH</th><th>Skill certificate</th></tr></thead>
      <tbody>${profileRows}</tbody>
    </table>
  </div>`;
}

function multiBarChart(
    title: string,
    rows: MeasurementRow[],
    series: { field: keyof MeasurementRow; label: string; color: string }[],
    unit: string,
    contextHtml = ""
) {
    const width = 1120;
    const groupHeight = 88;
    const height = 112 + rows.length * groupHeight;
    const labelWidth = 92;
    const plotWidth = width - labelWidth - 130;
    const scaleMax = niceAxisMax(Math.max(...rows.flatMap((row) => series.map((item) => Number(row[item.field] ?? 0))), 1));
    const axisY = 76 + rows.length * groupHeight;
    const legend = series.map((item, i) => {
        const x = labelWidth + i * 118;
        return `<rect x="${x}" y="10" width="12" height="12" fill="${item.color}"></rect><text class="bar-label" x="${x + 18}" y="21">${item.label}</text>`;
    }).join("");
    const bars = rows.map((row, rowIndex) => {
        const y0 = 34 + rowIndex * groupHeight;
        const rowBars = series.map((item, seriesIndex) => {
            const value = Number(row[item.field] ?? 0);
            const y = y0 + seriesIndex * 15;
            const barWidth = (value / scaleMax) * plotWidth;
            return `
    <rect x="${labelWidth}" y="${y}" width="${barWidth}" height="11" fill="${item.color}"></rect>
    <text class="bar-label" x="${labelWidth + barWidth + 5}" y="${y + 10}">${value.toFixed(2)} ${unit}</text>`;
        }).join("");
        return `
    <text class="bar-label" x="0" y="${y0 + 35}">${chartRowLabel(row)}</text>${rowBars}`;
    }).join("");

    return `<section>
  <h2>${title}</h2>
  ${contextHtml}
  <div class="chart">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
      ${legend}
      ${bars}
      ${chartAxis(labelWidth, axisY, plotWidth, scaleMax, unit)}
    </svg>
  </div>
</section>`;
}

function chartAxis(x: number, y: number, width: number, max: number, unit: string) {
    const step = niceTickStep(max);
    const ticks = Math.ceil(max / step);
    const lines = Array.from({ length: ticks + 1 }, (_, i) => {
        const value = step * i;
        const tx = x + (value / max) * width;
        return `
      <line class="tick" x1="${tx}" y1="${y - 4}" x2="${tx}" y2="${y + 4}"></line>
      <text class="bar-label" x="${tx}" y="${y + 18}" text-anchor="${i === 0 ? "start" : i === ticks ? "end" : "middle"}">${formatAxisValue(value)}</text>`;
    }).join("");
    return `
      <line class="axis" x1="${x}" y1="${y}" x2="${x + width}" y2="${y}"></line>
      <text class="axis-title" x="${x + width}" y="${y + 36}" text-anchor="end">${unit}</text>
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
    if (value >= 1_000) return Math.round(value).toLocaleString("it-IT");
    return value.toLocaleString("it-IT", { maximumFractionDigits: 2 });
}

function chartRowLabel(row: MeasurementRow) {
    if (row.weightStake && row.weightSkill) return `${row.weightStake}/${row.weightSkill}`;
    return row.user;
}

function barChart(
    title: string,
    rows: MeasurementRow[],
    leftField: keyof MeasurementRow,
    rightField: keyof MeasurementRow,
    leftLabel: string,
    rightLabel: string,
    unit: string
) {
    const width = 980;
    const height = 90 + rows.length * 42;
    const labelWidth = 92;
    const plotWidth = width - labelWidth - 24;
    const max = Math.max(...rows.flatMap((row) => [Number(row[leftField] ?? 0), Number(row[rightField] ?? 0)]), 1);
    const bars = rows.map((row, i) => {
        const y = 54 + i * 42;
        const left = Number(row[leftField] ?? 0);
        const right = Number(row[rightField] ?? 0);
        const leftWidth = (left / max) * (plotWidth / 2 - 22);
        const rightWidth = (right / max) * (plotWidth / 2 - 22);
        const mid = labelWidth + plotWidth / 2;
        return `
    <text class="bar-label" x="0" y="${y + 13}">${row.user}</text>
    <rect x="${labelWidth}" y="${y}" width="${leftWidth}" height="15" fill="#2f80ed"></rect>
    <text class="bar-label" x="${labelWidth + leftWidth + 5}" y="${y + 12}">${left.toFixed(2)} ${unit}</text>
    <rect x="${mid}" y="${y}" width="${rightWidth}" height="15" fill="#27ae60"></rect>
    <text class="bar-label" x="${mid + rightWidth + 5}" y="${y + 12}">${right.toFixed(2)} ${unit}</text>`;
    }).join("");

    return `<section>
  <h2>${title}</h2>
  <div class="chart">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
      <text class="bar-label" x="${labelWidth}" y="20">${leftLabel}</text>
      <text class="bar-label" x="${labelWidth + plotWidth / 2}" y="20">${rightLabel}</text>
      <line class="axis" x1="${labelWidth}" y1="30" x2="${width - 24}" y2="30"></line>
      ${bars}
    </svg>
  </div>
</section>`;
}

function writeReport(
    experiment1: MeasurementRow[],
    experiment2: MeasurementRow[],
    experiment3: MeasurementRow[],
    sensitivity: MeasurementRow[]
) {
    const whale = experiment2[0];
    const expertShareTokenOnly = experiment2
        .filter((row) => row.user.startsWith("Expert"))
        .reduce((sum, row) => sum + (row.shareTokenOnly ?? 0), 0);
    const expertShareHybrid = experiment2
        .filter((row) => row.user.startsWith("Expert"))
        .reduce((sum, row) => sum + (row.shareHybrid ?? 0), 0);

    const markdown = `# Misurazioni sperimentali voting power

## Experimental setup

Le misurazioni usano dataset sintetici piccoli e controllati, composti da 10 membri. Per isolare l'effetto della formula, a parita' di utenti, stake e skill vengono modificati solo:

- topic della proposta;
- \`weightStake\`;
- \`weightSkill\`.

I valori sono letti dai contratti Hardhat deployati nel test. Il voting power e' espresso in token \`COMP\`, dopo normalizzazione da wei.

## Esperimento 1 - Token-only vs modelli ibridi

Topic: AI & Data.

${markdownTable(experiment1, ["user", "stake", "skills", "skillScoreAI", "tokenOnlyVP", "stake75Skill25VP", "hybridVP", "stake25Skill75VP", "skillOnlyVP", "diff"])}

Interpretazione: nel modello token-only il VP coincide con la sola componente economica. Le configurazioni 75/25, 50/50 e 25/75 mostrano una transizione progressiva verso la componente skill. La configurazione 0/100 rappresenta un limite sperimentale only-competences: il deposito resta obbligatorio e tracciato, ma non genera token stake.

## Esperimento 2 - Whale vs expert minority

Topic: AI & Data.

${markdownTable(experiment2, ["user", "stake", "skills", "skillScoreAI", "tokenOnlyVP", "stake75Skill25VP", "hybridVP", "stake25Skill75VP", "skillOnlyVP", "shareTokenOnly", "share75_25", "shareHybrid", "share25_75", "shareSkillOnly"])}

Nel modello token-only il whale controlla il ${whale.shareTokenOnly?.toFixed(2)}% del voting power. Con pesi 50/50 la sua quota scende al ${whale.shareHybrid?.toFixed(2)}%. La quota aggregata dei tre esperti passa dal ${expertShareTokenOnly.toFixed(2)}% al ${expertShareHybrid.toFixed(2)}%. Il caso 0/100 mostra il limite massimo dell'effetto competenze, ma va letto come scenario di confronto e non come configurazione principale.

## Esperimento 3 - Topic sensitivity

Profili sintetici con stesso stake e combinazioni di skill rappresentative dei quattro topic. Cambia solo il topic della proposta.

${markdownTable(experiment3, ["user", "stake", "skills", "aiDataVP", "cloudCyberVP", "fintechBlockchainVP", "enterpriseSoftwareVP"])}

Il contributo economico del membro rimane invariato per tutti i topic, mentre la componente skill varia in funzione della pertinenza delle competenze rispetto al topic della proposta. Il profilo senza skill certificate funge da controllo: il suo VP resta identico su tutti i topic.

## Sensitivity analysis

Scenario whale/expert su AI & Data. La tabella mostra la quota del whale e la quota aggregata dei tre esperti al variare dei pesi.

${markdownTable(sensitivity, ["weightStake", "weightSkill", "whaleShare", "expertShare"])}

## File prodotti

- \`experiment-1-token-only-vs-hybrid.csv\`
- \`experiment-2-whale-vs-experts.csv\`
- \`experiment-3-topic-sensitivity.csv\`
- \`sensitivity-analysis.csv\`
- \`grafici.html\`
`;
    writeFileSync(join(OUT_DIR, "report.md"), markdown);
}

function markdownTable(rows: MeasurementRow[], columns: (keyof MeasurementRow)[]) {
    const header = `| ${columns.join(" | ")} |`;
    const divider = `| ${columns.map(() => "---").join(" |")} |`;
    const body = rows.map((row) =>
        `| ${columns.map((column) => formatCell(row[column])).join(" | ")} |`
    );
    return [header, divider, ...body].join("\n");
}

function formatCell(value: unknown) {
    if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
    if (Array.isArray(value)) return value.join(" + ");
    return String(value ?? "");
}

async function measureProfiles(profiles: MemberProfile[], weightStakeBp: bigint, weightSkillBp: bigint) {
    const deployment = await deployDAO(weightStakeBp, weightSkillBp);
    await setupProfiles(deployment, profiles);
    const blockNumber = await ethers.provider.getBlockNumber();
    await mine(1);

    const rows: MeasurementRow[] = [];
    for (let i = 0; i < profiles.length; i++) {
        const profile = profiles[i];
        rows.push({
            user: profile.label,
            stake: Number(profile.stakeEth),
            skills: profile.skills.length === 0 ? "nessuna" : profile.skills.join(" + "),
            skillScoreAI: await score(deployment.calculator, TOPIC_AI_DATA, profile.skills),
            skillScoreFinTech: await score(deployment.calculator, TOPIC_FINTECH_BLOCKCHAIN, profile.skills),
            hybridVP: round(await vp(deployment, deployment.members[i], TOPIC_AI_DATA, blockNumber)),
            aiVP: round(await vp(deployment, deployment.members[i], TOPIC_AI_DATA, blockNumber)),
            fintechVP: round(await vp(deployment, deployment.members[i], TOPIC_FINTECH_BLOCKCHAIN, blockNumber)),
            aiDataVP: round(await vp(deployment, deployment.members[i], TOPIC_AI_DATA, blockNumber)),
            cloudCyberVP: round(await vp(deployment, deployment.members[i], TOPIC_CLOUD_CYBERSECURITY, blockNumber)),
            fintechBlockchainVP: round(await vp(deployment, deployment.members[i], TOPIC_FINTECH_BLOCKCHAIN, blockNumber)),
            enterpriseSoftwareVP: round(await vp(deployment, deployment.members[i], TOPIC_ENTERPRISE_SOFTWARE, blockNumber)),
        });
    }
    return rows;
}

describe("Misurazioni tesi - composizione stake/skill del voting power", function () {
    it("produce tabelle, CSV e grafici per gli esperimenti principali", async function () {
        mkdirSync(OUT_DIR, { recursive: true });

        const baselineRows = await measureProfiles(mainProfiles, 10000n, 0n);
        const main75Rows = await measureProfiles(mainProfiles, 7500n, 2500n);
        const hybridRows = await measureProfiles(mainProfiles, 5000n, 5000n);
        const main25Rows = await measureProfiles(mainProfiles, 2500n, 7500n);
        const skillOnlyRows = await measureProfiles(mainProfiles, 0n, 10000n);
        const experiment1 = hybridRows.map((row, i) => ({
            ...row,
            tokenOnlyVP: baselineRows[i].hybridVP,
            stake75Skill25VP: main75Rows[i].hybridVP,
            stake25Skill75VP: main25Rows[i].hybridVP,
            skillOnlyVP: skillOnlyRows[i].hybridVP,
            diff: round((row.hybridVP ?? 0) - (baselineRows[i].hybridVP ?? 0)),
        }));

        const whaleBaseline = await measureProfiles(whaleProfiles, 10000n, 0n);
        const whale75 = await measureProfiles(whaleProfiles, 7500n, 2500n);
        const whaleHybrid = await measureProfiles(whaleProfiles, 5000n, 5000n);
        const whale25 = await measureProfiles(whaleProfiles, 2500n, 7500n);
        const whaleSkillOnly = await measureProfiles(whaleProfiles, 0n, 10000n);
        const tokenShares = shareRows(whaleBaseline.map((row) => ({ ...row, tokenOnlyVP: row.hybridVP })), "tokenOnlyVP");
        const shares75 = shareRows(whale75, "hybridVP");
        const hybridShares = shareRows(whaleHybrid, "hybridVP");
        const shares25 = shareRows(whale25, "hybridVP");
        const skillOnlyShares = shareRows(whaleSkillOnly, "hybridVP");
        const experiment2 = whaleHybrid.map((row, i) => ({
            ...row,
            tokenOnlyVP: whaleBaseline[i].hybridVP,
            stake75Skill25VP: whale75[i].hybridVP,
            stake25Skill75VP: whale25[i].hybridVP,
            skillOnlyVP: whaleSkillOnly[i].hybridVP,
            shareTokenOnly: tokenShares[i],
            share75_25: shares75[i],
            shareHybrid: hybridShares[i],
            share25_75: shares25[i],
            shareSkillOnly: skillOnlyShares[i],
        }));

        const experiment3 = await measureProfiles(topicProfiles, 5000n, 5000n);

        const sensitivityRows: MeasurementRow[] = [];
        for (const [label, stakeWeight, skillWeight] of [
            ["100/0", 10000n, 0n],
            ["75/25", 7500n, 2500n],
            ["50/50", 5000n, 5000n],
            ["25/75", 2500n, 7500n],
            ["0/100", 0n, 10000n],
        ] as const) {
            const rows = await measureProfiles(whaleProfiles, stakeWeight, skillWeight);
            const shares = shareRows(rows, "hybridVP");
            sensitivityRows.push({
                user: label,
                stake: 0,
                skills: "",
                skillScoreAI: 0,
                skillScoreFinTech: 0,
                weightStake: `${Number(stakeWeight) / 100}%`,
                weightSkill: `${Number(skillWeight) / 100}%`,
                whaleShare: shares[0],
                expertShare: round(shares[1] + shares[2] + shares[3]),
            });
        }

        writeFileSync(
            join(OUT_DIR, "experiment-1-token-only-vs-hybrid.csv"),
            toCsv(experiment1, [
                "user",
                "stake",
                "skills",
                "skillScoreAI",
                "skillScoreFinTech",
                "tokenOnlyVP",
                "stake75Skill25VP",
                "hybridVP",
                "stake25Skill75VP",
                "skillOnlyVP",
                "diff",
            ])
        );
        writeFileSync(
            join(OUT_DIR, "experiment-2-whale-vs-experts.csv"),
            toCsv(experiment2, [
                "user",
                "stake",
                "skills",
                "skillScoreAI",
                "tokenOnlyVP",
                "stake75Skill25VP",
                "hybridVP",
                "stake25Skill75VP",
                "skillOnlyVP",
                "shareTokenOnly",
                "share75_25",
                "shareHybrid",
                "share25_75",
                "shareSkillOnly",
            ])
        );
        writeFileSync(
            join(OUT_DIR, "experiment-3-topic-sensitivity.csv"),
            toCsv(experiment3, [
                "user",
                "stake",
                "skills",
                "aiDataVP",
                "cloudCyberVP",
                "fintechBlockchainVP",
                "enterpriseSoftwareVP",
            ])
        );
        writeFileSync(
            join(OUT_DIR, "sensitivity-analysis.csv"),
            toCsv(sensitivityRows, ["weightStake", "weightSkill", "whaleShare", "expertShare"])
        );

        writeBarChartHtml(experiment1, experiment2, experiment3, sensitivityRows);
        writeReport(experiment1, experiment2, experiment3, sensitivityRows);
    });
});

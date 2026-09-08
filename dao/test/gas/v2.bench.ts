// ============================================================================
//  test/gas/v2.bench.ts - V2 No Bitmap DAO - Gas Benchmark
//
//  Flusso utente misurato:
//    (1) joinDAO -> (2) delegate -> (3) registerDID -> (4) upgradeSkillWithVC
//    -> (5) proposeWithTopic -> (6) 10x castVote -> (7) queue -> (8) execute
//
//  Scenario fisso:
//    Membri : 10  (6 For + 4 Against)
//    Stake  : 5 ETH - weightStake/weightSkill: 50/50
//    Quorum : 20%  |  Superquorum: 70%
//    VC     : 2 skill (smart-contracts + tokenomics), no bitmap storage
//    Proposta: 10 ETH -> MockStartup (topic WEB3)
//
//  Gas: letto da ContractTransactionReceipt.gasUsed (hardhat-network).
//  Gas Price benchmark fisso: 1.03244 Gwei.
//  ETH Price benchmark fisso: $2638.48.
//
//  Eseguire con:
//    REPORT_GAS=false npx hardhat test test/gas/v2.bench.ts
// ============================================================================

import { ethers } from "hardhat";
import {
    impersonateAccount,
    loadFixture,
    mine,
    setBalance,
    stopImpersonatingAccount,
    time,
} from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";
import {
    GovernanceSkill,
    GovernanceToken,
    MyGovernor,
    Treasury,
    TimelockController,
    SkillCalculator,
    StartupRegistry,
    MockStartup,
} from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ContractTransactionReceipt } from "ethers";

const VOTING_DELAY = 1;
const VOTING_PERIOD = 50;
const TIMELOCK_DELAY = 3600;
const WEIGHT = 5000n;
const QUORUM = 20;
const SUPERQUORUM = 70;
const STAKE_ETH = "5";
const MEMBER_COUNT = 10;
const FOR_VOTERS = 6;
const AGAINST_VOTERS = MEMBER_COUNT - FOR_VOTERS;
const TOPIC_WEB3 = 0;
const VC_SKILLS = ["smart-contracts", "tokenomics"];

const ETH_PRICE_USD = 2638.48;
const GAS_PRICE_WEI = 1_032_440_000n;
const GAS_PRICE_GWEI_STR = "1.03244";

const EIP712_DOMAIN = { name: "Universal VC Protocol", version: "1" };
const VC_TYPES = {
    Issuer: [{ name: "id", type: "string" }],
    CredentialSubject: [
        { name: "id", type: "string" },
        { name: "university", type: "string" },
        { name: "faculty", type: "string" },
        { name: "skills", type: "string[]" },
    ],
    VerifiableCredential: [
        { name: "issuer", type: "Issuer" },
        { name: "issuanceDate", type: "string" },
        { name: "credentialSubject", type: "CredentialSubject" },
    ],
};

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

interface BenchmarkVC {
    vcData: {
        issuer: { id: string };
        issuanceDate: string;
        credentialSubject: {
            id: string;
            university: string;
            faculty: string;
            skills: string[];
        };
    };
    signature: string;
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

function perMember(gas: bigint): bigint {
    return gas / BigInt(MEMBER_COUNT);
}

function rec(label: string, receipt: ContractTransactionReceipt): GasMeasurement {
    const gas = receipt.gasUsed;
    return {
        operation: label,
        gasUsed: gas,
        costEth: toEth(gas),
        costUsd: toUsd(gas),
    };
}

async function resolveNetworkGasPrice(): Promise<bigint> {
    const feeData = await ethers.provider.getFeeData();
    return feeData.gasPrice ?? feeData.maxFeePerGas ?? ethers.parseUnits("1", "gwei");
}

function printTable(rows: GasMeasurement[], title: string) {
    const W = [50, 12, 20, 12];
    const LN = W.reduce((s, w) => s + w + 3, 0) - 1;
    const hr = "─".repeat(LN);
    const pad = (s: string, n: number) => s.padEnd(n);
    const padL = (s: string, n: number) => s.padStart(n);

    console.log("\n" + hr);
    console.log("  " + title);
    console.log("  Gas Price: " + GAS_PRICE_GWEI_STR + " Gwei  |  ETH: $" + ETH_PRICE_USD);
    console.log(hr);
    console.log(
        "  " +
            pad("Operation", W[0]) +
            " │ " +
            padL("Gas Used", W[1]) +
            " │ " +
            padL("Cost (ETH)", W[2]) +
            " │ " +
            padL("USD", W[3])
    );
    console.log(hr);
    for (const r of rows) {
        console.log(
            "  " +
                pad(r.operation, W[0]) +
                " │ " +
                padL(r.gasUsed.toString(), W[1]) +
                " │ " +
                padL(r.costEth, W[2]) +
                " │ " +
                padL(r.costUsd, W[3])
        );
    }
    console.log(hr);
}

function printAggregates(activation: bigint, cycle: bigint, totalGas: bigint) {
    const LN = 101;
    const hr = "─".repeat(LN);
    const LABEL_W = 72;
    const rows = [
        { label: `${MEMBER_COUNT} Member Activation Cost (join + delegate + registerDID + upgrade)`, gas: activation },
        { label: `Governance Cycle Cost    (propose + ${MEMBER_COUNT}x vote + queue + execute)`, gas: cycle },
        { label: "Per-Member Activation Estimate", gas: perMember(activation) },
        { label: "Per-Member Cycle Share Estimate", gas: perMember(cycle) },
        { label: "Per-Member Total Estimate", gas: perMember(totalGas) },
    ];

    console.log("\n  AGGREGATED COSTS");
    console.log(hr);
    for (const r of rows) {
        console.log(
            "  " +
                r.label.padEnd(LABEL_W) +
                " │ " +
                r.gas.toString().padStart(12) +
                " gas │ " +
                toUsd(r.gas).padStart(10)
        );
    }
    console.log(hr);
    console.log(
        "  " +
            "TOTAL GAS (activation + cycle)".padEnd(LABEL_W) +
            " │ " +
            totalGas.toString().padStart(12) +
            " gas │ " +
            toUsd(totalGas).padStart(10)
    );
    console.log(hr);
}

function printScalability(rows: ScalabilityRow[]) {
    const LN = 72;
    const hr = "─".repeat(LN);
    console.log("\n  SKILL ARRAY SCALABILITY - upgradeSkillWithVC gas cost vs. #skills in VC");
    console.log(hr);
    console.log(
        "  " +
            "#Skills".padEnd(10) +
            " │ " +
            "Skills".padEnd(38) +
            " │ " +
            "Gas Used".padStart(10) +
            " │ " +
            "USD".padStart(8)
    );
    console.log(hr);
    for (const r of rows) {
        console.log(
            "  " +
                String(r.skillCount).padEnd(10) +
                " │ " +
                r.skills.join(", ").padEnd(38) +
                " │ " +
                r.upgradeGas.toString().padStart(10) +
                " │ " +
                toUsd(r.upgradeGas).padStart(8)
        );
    }
    console.log(hr);
}

async function buildVC(
    issuerSigner: HardhatEthersSigner,
    holderAddr: string,
    skills: string[] = VC_SKILLS
): Promise<BenchmarkVC> {
    const vcData = {
        issuer: { id: "did:ethr:" + issuerSigner.address },
        issuanceDate: "2026-01-15T10:00:00Z",
        credentialSubject: {
            id: "did:ethr:" + holderAddr,
            university: "Pisa",
            faculty: "Protocol Security",
            skills,
        },
    };
    const signature = await issuerSigner.signTypedData(EIP712_DOMAIN, VC_TYPES, vcData);
    return { vcData, signature };
}

async function deployFixture() {
    const signers = await ethers.getSigners();
    const deployer = signers[0];
    const issuer = signers[2];
    const members = [signers[1], ...signers.slice(3, 3 + MEMBER_COUNT - 1)];

    if (members.length !== MEMBER_COUNT) {
        throw new Error(`not enough signers for ${MEMBER_COUNT} benchmark members`);
    }

    const Timelock = await ethers.getContractFactory("TimelockController");
    const timelock = (await Timelock.deploy(TIMELOCK_DELAY, [], [], deployer.address)) as unknown as TimelockController;
    await timelock.waitForDeployment();

    const Token = await ethers.getContractFactory("GovernanceToken");
    const token = (await Token.deploy(await timelock.getAddress(), WEIGHT, WEIGHT)) as unknown as GovernanceToken;
    await token.waitForDeployment();

    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    const treasury = (await TreasuryFactory.deploy(await timelock.getAddress())) as unknown as Treasury;
    await treasury.waitForDeployment();
    await token.setTreasury(await treasury.getAddress());

    const Registry = await ethers.getContractFactory("StartupRegistry");
    const registry = (await Registry.deploy(await timelock.getAddress())) as unknown as StartupRegistry;
    await registry.waitForDeployment();

    const Startup = await ethers.getContractFactory("MockStartup");
    const mockStartup = (await Startup.deploy()) as unknown as MockStartup;
    await mockStartup.waitForDeployment();

    const Calculator = await ethers.getContractFactory("SkillCalculator");
    const calculator = (await Calculator.deploy()) as unknown as SkillCalculator;
    await calculator.waitForDeployment();

    const Skill = await ethers.getContractFactory("GovernanceSkill");
    const skillModule = (await Skill.deploy(
        await token.getAddress(),
        await timelock.getAddress(),
        WEIGHT,
        await calculator.getAddress()
    )) as unknown as GovernanceSkill;
    await skillModule.waitForDeployment();
    await skillModule.setTrustedIssuer(issuer.address);

    const Governor = await ethers.getContractFactory("MyGovernor");
    const governor = (await Governor.deploy(
        await token.getAddress(),
        await skillModule.getAddress(),
        await timelock.getAddress(),
        VOTING_DELAY,
        VOTING_PERIOD,
        0,
        QUORUM,
        SUPERQUORUM
    )) as unknown as MyGovernor;
    await governor.waitForDeployment();

    const governorAddress = await governor.getAddress();
    await timelock.grantRole(await timelock.PROPOSER_ROLE(), governorAddress);
    await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
    await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);

    return { deployer, issuer, members, token, skillModule, governor, treasury, timelock, registry, mockStartup };
}

describe("V2 No Bitmap DAO - Gas Benchmark", function () {
    const flowMeasurements: GasMeasurement[] = [];
    const scalabilityRows: ScalabilityRow[] = [];

    before(async function () {
        const rawGasPrice = await resolveNetworkGasPrice();
        const networkGweiStr = (Number(rawGasPrice) / 1e9).toFixed(4);
        console.log("\n  [GasBench] Gas Price rete (solo info):  " + networkGweiStr + " Gwei");
        console.log("  [GasBench] Gas Price benchmark (fisso): " + GAS_PRICE_GWEI_STR + " Gwei  |  ETH: $" + ETH_PRICE_USD);
    });

    describe("Main User Flow", function () {
        let ctx: Awaited<ReturnType<typeof deployFixture>>;
        let proposalId: bigint;
        let proposalCalldata: string;
        let proposalDescHash: string;

        before(async function () {
            ctx = await loadFixture(deployFixture);
        });

        it("1. joinDAO - 10 members, 5 ETH each", async function () {
            const value = ethers.parseEther(STAKE_ETH);
            for (let i = 0; i < ctx.members.length; i++) {
                const tx = await ctx.token.connect(ctx.members[i]).joinDAO({ value });
                const receipt = await tx.wait();
                flowMeasurements.push(rec(`joinDAO  (member ${i + 1})`, receipt!));
            }
        });

        it("2. delegate - self-delegation, all 10 members", async function () {
            for (let i = 0; i < ctx.members.length; i++) {
                const member = ctx.members[i];
                const tx = await ctx.token.connect(member).delegate(member.address);
                const receipt = await tx.wait();
                flowMeasurements.push(rec(`delegate (member ${i + 1})`, receipt!));
            }
        });

        it("3. registerDID - all 10 members", async function () {
            for (let i = 0; i < ctx.members.length; i++) {
                const { vcData } = await buildVC(ctx.issuer, ctx.members[i].address);
                const tx = await ctx.skillModule.connect(ctx.members[i]).registerDID(vcData.credentialSubject.id);
                const receipt = await tx.wait();
                flowMeasurements.push(rec(`registerDID (member ${i + 1})`, receipt!));
            }
        });

        it("4. upgradeSkillWithVC - no bitmap skill array, all 10 members", async function () {
            for (let i = 0; i < ctx.members.length; i++) {
                const { vcData, signature } = await buildVC(ctx.issuer, ctx.members[i].address);
                const tx = await ctx.skillModule.connect(ctx.members[i]).upgradeSkillWithVC(vcData, signature);
                const receipt = await tx.wait();
                flowMeasurements.push(rec(`upgradeSkillWithVC  (member ${i + 1})`, receipt!));
            }
        });

        it("5. proposeWithTopic - invest 10 ETH in MockStartup", async function () {
            await ctx.deployer.sendTransaction({
                to: await ctx.treasury.getAddress(),
                value: ethers.parseEther("15"),
            });
            await ctx.treasury.setStartupRegistry(await ctx.registry.getAddress());

            const timelockAddress = await ctx.timelock.getAddress();
            await setBalance(timelockAddress, ethers.parseEther("1"));
            await impersonateAccount(timelockAddress);
            const timelockSigner = await ethers.getSigner(timelockAddress);
            try {
                await ctx.registry.connect(timelockSigner).registerStartup(
                    "MockStartup WEB3",
                    await ctx.mockStartup.getAddress(),
                    "Web3 infrastructure startup"
                );
            } finally {
                await stopImpersonatingAccount(timelockAddress);
            }

            const treasuryInterface = (await ethers.getContractFactory("Treasury")).interface;
            proposalCalldata = treasuryInterface.encodeFunctionData("investStartup", [0n, ethers.parseEther("10")]);
            const desc = "Invest 10 ETH in MockStartup WEB3 - V2 no bitmap";
            proposalDescHash = ethers.id(desc);

            await mine(1);

            const tx = await ctx.governor.connect(ctx.members[0]).proposeWithTopic(
                [await ctx.treasury.getAddress()],
                [0n],
                [proposalCalldata],
                desc,
                TOPIC_WEB3
            );
            const receipt = await tx.wait();
            flowMeasurements.push(rec("proposeWithTopic   (topicId stored + ProposalCreated)", receipt!));

            const parsed = receipt!.logs
                .map((log: any) => {
                    try {
                        return ctx.governor.interface.parseLog(log);
                    } catch {
                        return null;
                    }
                })
                .find((log: any) => log?.name === "ProposalCreated");
            proposalId = parsed!.args!.proposalId;
        });

        it("6. castVote - 6 For + 4 Against", async function () {
            await mine(VOTING_DELAY + 1);

            for (let i = 0; i < ctx.members.length; i++) {
                const support = i < FOR_VOTERS ? 1 : 0;
                const label = support === 1 ? "For" : "Against";
                const tx = await ctx.governor.connect(ctx.members[i]).castVote(proposalId, support);
                const receipt = await tx.wait();
                flowMeasurements.push(rec(`castVote ${label.padEnd(7)} (member ${i + 1})`, receipt!));
            }
        });

        it("7. queue - proposal queued in TimelockController", async function () {
            await mine(VOTING_PERIOD);

            const tx = await ctx.governor.queue(
                [await ctx.treasury.getAddress()],
                [0n],
                [proposalCalldata],
                proposalDescHash
            );
            const receipt = await tx.wait();
            flowMeasurements.push(rec("queue", receipt!));
        });

        it("8. execute - Treasury.investStartup(10 ETH) via TimelockController", async function () {
            await time.increase(TIMELOCK_DELAY + 1);

            const tx = await ctx.governor.execute(
                [await ctx.treasury.getAddress()],
                [0n],
                [proposalCalldata],
                proposalDescHash
            );
            const receipt = await tx.wait();
            flowMeasurements.push(rec("execute            (Timelock -> Treasury.investStartup)", receipt!));
        });

        it("REPORT - Main Flow", function () {
            const { activation, cycle, totalGas } = aggregate(flowMeasurements);

            printTable(
                flowMeasurements,
                "V2 No Bitmap DAO │ " +
                    GAS_PRICE_GWEI_STR +
                    " Gwei · ETH $" +
                    ETH_PRICE_USD +
                    ` │ ${MEMBER_COUNT} members: ${FOR_VOTERS} For + ${AGAINST_VOTERS} Against`
            );
            printAggregates(activation, cycle, totalGas);
        });
    });

    describe("Skill Array Scalability - upgradeSkillWithVC vs. #skills in VC", function () {
        async function runScalabilityUpgrade(skillNames: string[]): Promise<bigint> {
            const ctx = await loadFixture(deployFixture);
            const member = ctx.members[2];

            await ctx.token.connect(member).joinDAO({ value: ethers.parseEther(STAKE_ETH) });
            await ctx.token.connect(member).delegate(member.address);
            const { vcData, signature } = await buildVC(ctx.issuer, member.address, skillNames);
            await ctx.skillModule.connect(member).registerDID(vcData.credentialSubject.id);

            const tx = await ctx.skillModule.connect(member).upgradeSkillWithVC(vcData, signature);
            const receipt = await tx.wait();
            return receipt!.gasUsed;
        }

        it("1 skill - smart-contracts", async function () {
            const skills = ["smart-contracts"];
            const gas = await runScalabilityUpgrade(skills);
            scalabilityRows.push({ skillCount: skills.length, skills, upgradeGas: gas });
        });

        it("2 skills - smart-contracts + tokenomics", async function () {
            const skills = ["smart-contracts", "tokenomics"];
            const gas = await runScalabilityUpgrade(skills);
            scalabilityRows.push({ skillCount: skills.length, skills, upgradeGas: gas });
        });

        it("4 skills - Web3/AI/Health mixed", async function () {
            const skills = ["smart-contracts", "tokenomics", "machine-learning", "data-analysis"];
            const gas = await runScalabilityUpgrade(skills);
            scalabilityRows.push({ skillCount: skills.length, skills, upgradeGas: gas });
        });

        it("6 skills - all supported skills, no bitmap", async function () {
            const skills = [
                "smart-contracts",
                "machine-learning",
                "tokenomics",
                "digital-health",
                "data-analysis",
                "backend-java",
            ];
            const gas = await runScalabilityUpgrade(skills);
            scalabilityRows.push({ skillCount: skills.length, skills, upgradeGas: gas });
        });

        it("REPORT - Scalability", function () {
            if (scalabilityRows.length === 0) return;
            printScalability(scalabilityRows);
        });
    });

    after(function () {
        if (flowMeasurements.length === 0) return;

        const { activation, cycle, totalGas } = aggregate(flowMeasurements);
        const result = {
            version: "V2-NoBitmap",
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
                vcSkills: VC_SKILLS,
                proposalAmountEth: 10,
                proposalTopic: "WEB3",
                proposalTopicId: TOPIC_WEB3,
                votersFor: FOR_VOTERS,
                votersAgainst: AGAINST_VOTERS,
            },
            architecture: {
                skillStorage: "bytes32[] + memberHasSkill mapping",
                bitmap: false,
                governorApi: "proposeWithTopic",
            },
            flow: flowMeasurements.map((m) => ({
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
            scalability: scalabilityRows.map((r) => ({
                skillCount: r.skillCount,
                skills: r.skills,
                upgradeGas: r.upgradeGas.toString(),
                costEth: toEth(r.upgradeGas),
                costUsd: toUsd(r.upgradeGas),
            })),
        };

        const outPath = path.resolve(__dirname, "../../benchmark-v2.json");
        fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
        console.log("\n  JSON written to: " + outPath + "\n");
    });
});

function aggregate(rows: GasMeasurement[]) {
    const find = (prefix: string) => rows.find((m) => m.operation.startsWith(prefix))?.gasUsed ?? 0n;
    const sum = (prefix: string) =>
        rows.filter((m) => m.operation.startsWith(prefix)).reduce((acc, m) => acc + m.gasUsed, 0n);

    const activation = sum("joinDAO") + sum("delegate") + sum("registerDID") + sum("upgradeSkillWithVC");
    const cycle = find("proposeWithTopic") + sum("castVote") + find("queue") + find("execute");
    return { activation, cycle, totalGas: activation + cycle };
}

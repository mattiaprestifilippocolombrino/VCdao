// ============================================================================
//  test/gas/v1.bench.ts - V1 No Topic With Override - Gas Benchmark
//
//  Measured user flow:
//    (1) joinDAO -> (2) delegate -> (3) registerDID -> (4) upgradeCompetenceWithVP
//    -> (5) propose -> (6) 10x castVote -> (7) queue -> (8) execute
//
//  Fixed scenario:
//    Members : 10  (6 For + 4 Against)
//    Stake   : 5 ETH - pesoSoldi/pesoCompetenze: 50/50
//    Quorum  : 20%  |  Superquorum: 70%
//    VC      : MasterDegree, using the V1 degree-based VC schema
//    Proposal: 10 ETH -> MockStartup through Treasury.invest()
//
//  Gas is read from ContractTransactionReceipt.gasUsed.
//  Benchmark gas price: 1.03244 Gwei.
//  Benchmark ETH price: $2638.48.
//
//  Run:
//    REPORT_GAS=false npx hardhat test test/gas/v1.bench.ts
// ============================================================================

import { ethers } from "hardhat";
import { loadFixture, mine, time } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";
import {
    GovernanceToken,
    MyGovernor,
    Treasury,
    TimelockController,
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
const VC_DEGREE_TITLE = "MasterDegree";
const VC_GRADE = "110/110";

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
        { name: "degreeTitle", type: "string" },
        { name: "grade", type: "string" },
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

interface BenchmarkVC {
    vcData: {
        issuer: { id: string };
        issuanceDate: string;
        credentialSubject: {
            id: string;
            university: string;
            faculty: string;
            degreeTitle: string;
            grade: string;
        };
    };
    signature: string;
}

function toEth(gas: bigint): string {
    return ethers.formatEther(gas * GAS_PRICE_WEI);
}

function toUsd(gas: bigint): string {
    const value = parseFloat(toEth(gas)) * ETH_PRICE_USD;
    if (value < 0.0001) return "< .0001";
    if (value < 0.01) return "$" + value.toFixed(5);
    if (value < 1) return "$" + value.toFixed(4);
    return "$" + value.toFixed(2);
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
    const widths = [50, 12, 20, 12];
    const lineLength = widths.reduce((sum, width) => sum + width + 3, 0) - 1;
    const hr = "─".repeat(lineLength);
    const pad = (value: string, width: number) => value.padEnd(width);
    const padL = (value: string, width: number) => value.padStart(width);

    console.log("\n" + hr);
    console.log("  " + title);
    console.log("  Gas Price: " + GAS_PRICE_GWEI_STR + " Gwei  |  ETH: $" + ETH_PRICE_USD);
    console.log(hr);
    console.log(
        "  " +
            pad("Operation", widths[0]) +
            " │ " +
            padL("Gas Used", widths[1]) +
            " │ " +
            padL("Cost (ETH)", widths[2]) +
            " │ " +
            padL("USD", widths[3])
    );
    console.log(hr);
    for (const row of rows) {
        console.log(
            "  " +
                pad(row.operation, widths[0]) +
                " │ " +
                padL(row.gasUsed.toString(), widths[1]) +
                " │ " +
                padL(row.costEth, widths[2]) +
                " │ " +
                padL(row.costUsd, widths[3])
        );
    }
    console.log(hr);
}

function printAggregates(activation: bigint, cycle: bigint, totalGas: bigint) {
    const hr = "─".repeat(101);
    const labelWidth = 72;
    const rows = [
        { label: `${MEMBER_COUNT} Member Activation Cost (join + delegate + registerDID + upgrade)`, gas: activation },
        { label: `Governance Cycle Cost    (propose + ${MEMBER_COUNT}x vote + queue + execute)`, gas: cycle },
        { label: "Per-Member Activation Estimate", gas: perMember(activation) },
        { label: "Per-Member Cycle Share Estimate", gas: perMember(cycle) },
        { label: "Per-Member Total Estimate", gas: perMember(totalGas) },
    ];

    console.log("\n  AGGREGATED COSTS");
    console.log(hr);
    for (const row of rows) {
        console.log(
            "  " +
                row.label.padEnd(labelWidth) +
                " │ " +
                row.gas.toString().padStart(12) +
                " gas │ " +
                toUsd(row.gas).padStart(10)
        );
    }
    console.log(hr);
    console.log(
        "  " +
            "TOTAL GAS (activation + cycle)".padEnd(labelWidth) +
            " │ " +
            totalGas.toString().padStart(12) +
            " gas │ " +
            toUsd(totalGas).padStart(10)
    );
    console.log(hr);
}

async function buildVC(
    issuerSigner: HardhatEthersSigner,
    holderAddress: string,
    degreeTitle = VC_DEGREE_TITLE,
    grade = VC_GRADE
): Promise<BenchmarkVC> {
    const vcData = {
        issuer: { id: "did:ethr:sepolia:" + issuerSigner.address },
        issuanceDate: "2026-01-15T10:00:00Z",
        credentialSubject: {
            id: "did:ethr:sepolia:" + holderAddress,
            university: "University of Pisa",
            faculty: "Computer Science",
            degreeTitle,
            grade,
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
    await token.setTrustedIssuer(issuer.address);

    const Governor = await ethers.getContractFactory("MyGovernor");
    const governor = (await Governor.deploy(
        await token.getAddress(),
        await timelock.getAddress(),
        VOTING_DELAY,
        VOTING_PERIOD,
        0,
        QUORUM,
        SUPERQUORUM
    )) as unknown as MyGovernor;
    await governor.waitForDeployment();

    const Startup = await ethers.getContractFactory("MockStartup");
    const mockStartup = (await Startup.deploy()) as unknown as MockStartup;
    await mockStartup.waitForDeployment();

    const governorAddress = await governor.getAddress();
    await timelock.grantRole(await timelock.PROPOSER_ROLE(), governorAddress);
    await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
    await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);

    return { deployer, issuer, members, token, governor, treasury, timelock, mockStartup };
}

describe("V1 No Topic With Override - Gas Benchmark", function () {
    const flowMeasurements: GasMeasurement[] = [];

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
                const tx = await ctx.token.connect(ctx.members[i]).registerDID(vcData.credentialSubject.id);
                const receipt = await tx.wait();
                flowMeasurements.push(rec(`registerDID (member ${i + 1})`, receipt!));
            }
        });

        it("4. upgradeCompetenceWithVP - all 10 members get degree VP", async function () {
            for (let i = 0; i < ctx.members.length; i++) {
                const { vcData, signature } = await buildVC(ctx.issuer, ctx.members[i].address);
                const tx = await ctx.token.connect(ctx.members[i]).upgradeCompetenceWithVP(vcData, signature);
                const receipt = await tx.wait();
                flowMeasurements.push(rec(`upgradeCompetenceWithVP (member ${i + 1})`, receipt!));
            }
        });

        it("5. propose - invest 10 ETH in MockStartup", async function () {
            proposalCalldata = ctx.treasury.interface.encodeFunctionData("invest", [
                await ctx.mockStartup.getAddress(),
                ethers.parseEther("10"),
            ]);
            const desc = "Invest 10 ETH in MockStartup - V1 no topic";
            proposalDescHash = ethers.id(desc);

            await mine(1);

            const tx = await ctx.governor.connect(ctx.members[0]).propose(
                [await ctx.treasury.getAddress()],
                [0n],
                [proposalCalldata],
                desc
            );
            const receipt = await tx.wait();
            flowMeasurements.push(rec("propose", receipt!));

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

        it("8. execute - Treasury.invest(10 ETH) via TimelockController", async function () {
            await time.increase(TIMELOCK_DELAY + 1);

            const tx = await ctx.governor.execute(
                [await ctx.treasury.getAddress()],
                [0n],
                [proposalCalldata],
                proposalDescHash
            );
            const receipt = await tx.wait();
            flowMeasurements.push(rec("execute            (Timelock -> Treasury.invest)", receipt!));
        });

        it("REPORT - Main Flow", function () {
            const { activation, cycle, totalGas } = aggregate(flowMeasurements);

            printTable(
                flowMeasurements,
                "V1 No Topic With Override │ " +
                    GAS_PRICE_GWEI_STR +
                    " Gwei · ETH $" +
                    ETH_PRICE_USD +
                    ` │ ${MEMBER_COUNT} members: ${FOR_VOTERS} For + ${AGAINST_VOTERS} Against`
            );
            printAggregates(activation, cycle, totalGas);
        });
    });

    after(function () {
        if (flowMeasurements.length === 0) return;

        const { activation, cycle, totalGas } = aggregate(flowMeasurements);
        const result = {
            version: "V1-NoTopicWithOverride",
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
                vcDegreeTitle: VC_DEGREE_TITLE,
                vcGrade: VC_GRADE,
                proposalAmountEth: 10,
                proposalTarget: "MockStartup",
                votersFor: FOR_VOTERS,
                votersAgainst: AGAINST_VOTERS,
            },
            architecture: {
                topicBased: false,
                votingPowerOverride: "stake ERC20Votes + skill checkpoints in GovernanceToken",
                vcModel: "degreeTitle/grade",
                governorApi: "propose",
                treasuryApi: "invest",
            },
            flow: flowMeasurements.map((measurement) => ({
                operation: measurement.operation,
                gasUsed: measurement.gasUsed.toString(),
                costEth: measurement.costEth,
                costUsd: measurement.costUsd,
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
            scalability: [],
        };

        const outPath = path.resolve(__dirname, "../../benchmark-v1.json");
        fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
        console.log("\n  JSON written to: " + outPath + "\n");
    });
});

function aggregate(rows: GasMeasurement[]) {
    const find = (prefix: string) => rows.find((measurement) => measurement.operation.startsWith(prefix))?.gasUsed ?? 0n;
    const sum = (prefix: string) =>
        rows.filter((measurement) => measurement.operation.startsWith(prefix)).reduce((acc, measurement) => acc + measurement.gasUsed, 0n);

    const activation = sum("joinDAO") + sum("delegate") + sum("registerDID") + sum("upgradeCompetenceWithVP");
    const cycle = find("propose") + sum("castVote") + find("queue") + find("execute");
    return { activation, cycle, totalGas: activation + cycle };
}

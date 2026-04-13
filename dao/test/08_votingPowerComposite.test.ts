// ============================================================================
//  08_votingPowerComposite.test.ts — Test modello Voting Power Composto (VPC)
//
//  Verifica la formula: VP(member) = baseTokens × [(1 − k) + k × score]
//  dove k = competenceWeight / 10.000 (parametro configurabile al deploy).
//
//  Proprietà testate:
//    • k = 0       → VP puramente economico
//    • k = 10.000  → VP = baseTokens × score (legacy)
//    • k = 5.000   → blend 50/50 tra economico e competenza
//    • getVotingPowerBreakdown restituisce scomposizione corretta
//    • computeVotingTokens è coerente con minting e upgrade
// ============================================================================

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import { GovernanceToken, Treasury, TimelockController } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Helper: deploya l'intera infrastruttura con un dato k
async function deployWithK(
    k: bigint,
    deployer: HardhatEthersSigner
): Promise<{ token: GovernanceToken; treasury: Treasury; timelock: TimelockController }> {
    const Timelock = await ethers.getContractFactory("TimelockController");
    const timelock = await Timelock.deploy(3600, [], [], deployer.address);
    await timelock.waitForDeployment();

    const Token = await ethers.getContractFactory("GovernanceToken");
    const token = await Token.deploy(await timelock.getAddress(), k);
    await token.waitForDeployment();

    const Treasury_ = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury_.deploy(await timelock.getAddress());
    await treasury.waitForDeployment();

    await token.setTreasury(await treasury.getAddress());
    return { token, treasury, timelock };
}

// Helper: impersona Timelock per chiamata diretta
async function callAsTimelock(
    timelock: TimelockController,
    funder: HardhatEthersSigner,
    fn: (signer: HardhatEthersSigner) => Promise<any>
): Promise<any> {
    const addr = await timelock.getAddress();
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
    await funder.sendTransaction({ to: addr, value: ethers.parseEther("1") });
    const signer = await ethers.getSigner(addr);
    const result = await fn(signer);
    await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [addr] });
    return result;
}

describe("Voting Power Composto (VPC) — VP = baseTokens × [(1−k) + k × score]", function () {
    let deployer: HardhatEthersSigner;
    let alice: HardhatEthersSigner;
    let bob: HardhatEthersSigner;

    before(async function () {
        [deployer, alice, bob] = await ethers.getSigners();
    });

    // =========================================================================
    //  1. RETROCOMPATIBILITÀ: k = 10.000 (legacy, pieno merito)
    // =========================================================================
    describe("k = 10.000 (legacy)", function () {
        let token: GovernanceToken;
        let timelock: TimelockController;

        beforeEach(async function () {
            const env = await deployWithK(10000n, deployer);
            token = env.token; timelock = env.timelock;
        });

        it("joinDAO minta baseTokens (Student, score=1 → identico a legacy)", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("5000", 18));
        });

        it("mintTokens con PhD (score=4) minta newBase × 4", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            // Upgrade a PhD via Timelock
            await callAsTimelock(timelock, deployer, s =>
                token.connect(s).upgradeCompetence(alice.address, 3, "PhD")
            );
            await token.connect(alice).mintTokens({ value: ethers.parseEther("2") });
            // balance = 5000 (join) + 15000 (upgrade: 5000×3) + 8000 (mint: 2000×4) = 28000
            expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("28000", 18));
        });

        it("upgrade Student→PhD: additionalTokens = base × (4-1) = base × 3", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            await callAsTimelock(timelock, deployer, s =>
                token.connect(s).upgradeCompetence(alice.address, 3, "PhD")
            );
            // 5000 + 5000×3 = 20000
            expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("20000", 18));
        });
    });

    // =========================================================================
    //  2. PURAMENTE ECONOMICO: k = 0
    // =========================================================================
    describe("k = 0 (puramente economico)", function () {
        let token: GovernanceToken;
        let timelock: TimelockController;

        beforeEach(async function () {
            const env = await deployWithK(0n, deployer);
            token = env.token; timelock = env.timelock;
        });

        it("joinDAO minta baseTokens (invariante: Student score=1 sempre)", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("5000", 18));
        });

        it("upgrade NON genera token aggiuntivi (k=0 → delta=0)", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            await callAsTimelock(timelock, deployer, s =>
                token.connect(s).upgradeCompetence(alice.address, 3, "PhD")
            );
            // 5000 + 0 = 5000 (nessun bonus competenza)
            expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("5000", 18));
        });

        it("mintTokens con PhD minta newBase × 1 (competenza irrilevante)", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            await callAsTimelock(timelock, deployer, s =>
                token.connect(s).upgradeCompetence(alice.address, 3, "PhD")
            );
            await token.connect(alice).mintTokens({ value: ethers.parseEther("2") });
            // 5000 + 0 (upgrade) + 2000 (mint: computeVotingTokens(2000,4) con k=0 = 2000)
            expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("7000", 18));
        });

        it("getVotingPowerBreakdown: 100% economico, 0% competenza", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            const [eco, comp, total] = await token.getVotingPowerBreakdown(alice.address);
            expect(eco).to.equal(ethers.parseUnits("5000", 18)); // 100% economico
            expect(comp).to.equal(0n); // 0% competenza
            expect(total).to.equal(ethers.parseUnits("5000", 18));
        });
    });

    // =========================================================================
    //  3. BLEND 50/50: k = 5.000
    // =========================================================================
    describe("k = 5.000 (blend 50/50)", function () {
        let token: GovernanceToken;
        let timelock: TimelockController;

        beforeEach(async function () {
            const env = await deployWithK(5000n, deployer);
            token = env.token; timelock = env.timelock;
        });

        it("joinDAO minta baseTokens (Student score=1 → formula dà base)", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            // computeVotingTokens(5000, 1) = 5000 × (5000 + 5000×1)/10000 = 5000
            expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("5000", 18));
        });

        it("upgrade Student→PhD: delta = base × k × 3 / 10000 = base × 1.5", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            await callAsTimelock(timelock, deployer, s =>
                token.connect(s).upgradeCompetence(alice.address, 3, "PhD")
            );
            // delta = 5000 × 5000 × 3 / 10000 = 7500
            // totale = 5000 + 7500 = 12500
            expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("12500", 18));
        });

        it("upgrade Student→Professor: delta = base × k × 4 / 10000 = base × 2", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            await callAsTimelock(timelock, deployer, s =>
                token.connect(s).upgradeCompetence(alice.address, 4, "Professor")
            );
            // delta = 5000 × 5000 × 4 / 10000 = 10000
            // totale = 5000 + 10000 = 15000
            expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("15000", 18));
        });

        it("mintTokens con PhD (score=4): newBase × [(1-0.5) + 0.5×4] = newBase × 2.5", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            await callAsTimelock(timelock, deployer, s =>
                token.connect(s).upgradeCompetence(alice.address, 3, "PhD")
            );
            await token.connect(alice).mintTokens({ value: ethers.parseEther("2") });
            // mint: computeVotingTokens(2000, 4) = 2000 × (5000 + 20000)/10000 = 5000
            // totale = 5000 + 7500 + 5000 = 17500
            expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("17500", 18));
        });

        it("upgrade progressivo PhD→Professor dopo mint aggiuntivo", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            // Upgrade a PhD
            await callAsTimelock(timelock, deployer, s =>
                token.connect(s).upgradeCompetence(alice.address, 3, "PhD")
            );
            // Mint aggiuntivi
            await token.connect(alice).mintTokens({ value: ethers.parseEther("2") });
            // baseTokens = 5000 + 2000 = 7000
            // balance = 17500

            // Upgrade PhD→Professor
            await callAsTimelock(timelock, deployer, s =>
                token.connect(s).upgradeCompetence(alice.address, 4, "Professor")
            );
            // delta = 7000 × 5000 × (5-4) / 10000 = 3500
            // totale = 17500 + 3500 = 21000
            // Verifica: computeVotingTokens(7000, 5) = 7000 × (5000 + 25000)/10000 = 21000 ✓
            expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("21000", 18));
        });

        it("getVotingPowerBreakdown con PhD (score=4): eco=50%, comp=50%×4", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            await callAsTimelock(timelock, deployer, s =>
                token.connect(s).upgradeCompetence(alice.address, 3, "PhD")
            );
            const [eco, comp, total] = await token.getVotingPowerBreakdown(alice.address);
            const base = ethers.parseUnits("5000", 18);
            // eco = 5000 × (10000-5000)/10000 = 2500
            expect(eco).to.equal(base * 5000n / 10000n);
            // comp = 5000 × 5000 × 4 / 10000 = 10000
            expect(comp).to.equal(base * 5000n * 4n / 10000n);
            // total = 2500 + 10000 = 12500
            expect(total).to.equal(ethers.parseUnits("12500", 18));
        });
    });

    // =========================================================================
    //  4. FUNZIONE computeVotingTokens — test puro
    // =========================================================================
    describe("computeVotingTokens — verifica formula pura", function () {
        it("k=10000: computeVotingTokens(1000, score) = 1000 × score", async function () {
            const { token } = await deployWithK(10000n, deployer);
            const base = ethers.parseUnits("1000", 18);
            for (let score = 1; score <= 5; score++) {
                const result = await token.computeVotingTokens(base, score);
                expect(result).to.equal(base * BigInt(score));
            }
        });

        it("k=0: computeVotingTokens(1000, score) = 1000 ∀ score", async function () {
            const { token } = await deployWithK(0n, deployer);
            const base = ethers.parseUnits("1000", 18);
            for (let score = 1; score <= 5; score++) {
                const result = await token.computeVotingTokens(base, score);
                expect(result).to.equal(base);
            }
        });

        it("k=5000: computeVotingTokens(1000, 4) = 1000 × 2.5 = 2500", async function () {
            const { token } = await deployWithK(5000n, deployer);
            const base = ethers.parseUnits("1000", 18);
            const result = await token.computeVotingTokens(base, 4);
            // (5000 + 5000×4) / 10000 = 25000/10000 = 2.5
            expect(result).to.equal(ethers.parseUnits("2500", 18));
        });

        it("k=3000: computeVotingTokens(1000, 5) = 1000 × [0.7 + 0.3×5] = 2200", async function () {
            const { token } = await deployWithK(3000n, deployer);
            const base = ethers.parseUnits("1000", 18);
            const result = await token.computeVotingTokens(base, 5);
            // (7000 + 3000×5) / 10000 = 22000/10000 = 2.2
            expect(result).to.equal(ethers.parseUnits("2200", 18));
        });
    });

    // =========================================================================
    //  5. VOTING POWER INTEGRATO CON DELEGA
    // =========================================================================
    describe("VP integrato con delega — k=5000", function () {
        let token: GovernanceToken;
        let timelock: TimelockController;

        beforeEach(async function () {
            const env = await deployWithK(5000n, deployer);
            token = env.token; timelock = env.timelock;
        });

        it("getVotes riflette il VP pesato dopo upgrade e delega", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            await token.connect(alice).delegate(alice.address);
            await mine(1);

            // Voting power iniziale = 5000 (Student, score=1)
            expect(await token.getVotes(alice.address)).to.equal(ethers.parseUnits("5000", 18));

            // Upgrade a PhD
            await callAsTimelock(timelock, deployer, s =>
                token.connect(s).upgradeCompetence(alice.address, 3, "PhD")
            );

            // Re-delega per aggiornare checkpoint con i nuovi token
            await token.connect(alice).delegate(alice.address);

            // getVotes = balance = 12500
            expect(await token.getVotes(alice.address)).to.equal(ethers.parseUnits("12500", 18));
        });

        it("confronto VP tra due membri con diversa competenza", async function () {
            // Alice: 10 ETH, Student
            await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
            await token.connect(alice).delegate(alice.address);

            // Bob: 5 ETH, ma PhD
            await token.connect(bob).joinDAO({ value: ethers.parseEther("5") });
            await callAsTimelock(timelock, deployer, s =>
                token.connect(s).upgradeCompetence(bob.address, 3, "PhD")
            );
            await token.connect(bob).delegate(bob.address);
            await mine(1);

            const vpAlice = await token.getVotes(alice.address);
            const vpBob = await token.getVotes(bob.address);

            // Alice: 10000 token (Student)
            // Bob: 5000 + 7500 = 12500 token (PhD, k=5000)
            expect(vpAlice).to.equal(ethers.parseUnits("10000", 18));
            expect(vpBob).to.equal(ethers.parseUnits("12500", 18));

            // Con k=5000, il PhD con 5 ETH supera il Student con 10 ETH!
            expect(vpBob).to.be.greaterThan(vpAlice);
        });
    });

    // =========================================================================
    //  6. EDGE CASE e VALIDAZIONE
    // =========================================================================
    describe("Edge cases", function () {
        it("constructor reverta con k > 10000", async function () {
            const Timelock = await ethers.getContractFactory("TimelockController");
            const tl = await Timelock.deploy(3600, [], [], deployer.address);
            await tl.waitForDeployment();

            const Token = await ethers.getContractFactory("GovernanceToken");
            await expect(
                Token.deploy(await tl.getAddress(), 10001n)
            ).to.be.revertedWithCustomError(Token, "InvalidCompetenceWeight");
        });

        it("competenceWeight è immutabile e corrisponde al valore di deploy", async function () {
            const { token } = await deployWithK(7500n, deployer);
            expect(await token.competenceWeight()).to.equal(7500n);
        });

        it("BASIS_POINTS è 10.000", async function () {
            const { token } = await deployWithK(5000n, deployer);
            expect(await token.BASIS_POINTS()).to.equal(10000n);
        });
    });
});

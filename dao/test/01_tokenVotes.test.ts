// ============================================================================
//  01_tokenVotes.test.ts — Test del GovernanceToken (joinDAO + Competenza)
// ============================================================================

import { expect } from "chai";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import { GovernanceToken, Treasury, TimelockController } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("GovernanceToken — joinDAO + ERC20Votes", function () {
    let token: GovernanceToken;
    let treasury: Treasury;
    let timelock: TimelockController;
    let deployer: HardhatEthersSigner;
    let alice: HardhatEthersSigner;
    let bob: HardhatEthersSigner;

    const TIMELOCK_DELAY = 3600;

    beforeEach(async function () {
        [deployer, alice, bob] = await ethers.getSigners();

        const Timelock = await ethers.getContractFactory("TimelockController");
        timelock = await Timelock.deploy(TIMELOCK_DELAY, [], [], deployer.address);
        await timelock.waitForDeployment();

        const Token = await ethers.getContractFactory("GovernanceToken");
        token = await Token.deploy(await timelock.getAddress(), 5000n, 5000n);
        await token.waitForDeployment();

        const Treasury_ = await ethers.getContractFactory("Treasury");
        treasury = await Treasury_.deploy(await timelock.getAddress());
        await treasury.waitForDeployment();

        await token.setTreasury(await treasury.getAddress());
    });

    // ── joinDAO() ──
    // Con pesi pesoSoldi=5000/10000 e pesoCompetenze=5000/10000:
    // token mintati per soldi = (scoreSoldi × pesoSoldi) / BASIS_POINTS
    // scoreSoldi = min(ethDeposited / 100 ETH, 1) × 100

    it("joinDAO() minta i token VPC corretti per 1 ETH (scoreSoldi=1 → 0.5 token)", async function () {
        // scoreSoldi(1 ETH) = 1% × 100 = 1
        // token = 1 × pesoSoldi(5000) / 10000 = 0.5 × 10^18
        await token.connect(alice).joinDAO({ value: ethers.parseEther("1") });
        expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("0.5"));
    });

    it("joinDAO() minta i token VPC corretti per 50 ETH (scoreSoldi=50 → 25 token)", async function () {
        // scoreSoldi(50 ETH) = 50% × 100 = 50
        // token = 50 × pesoSoldi(5000) / 10000 = 25 × 10^18
        await token.connect(alice).joinDAO({ value: ethers.parseEther("50") });
        expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("25"));
    });

    it("joinDAO() registra il membro come Student", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        expect(await token.isMember(alice.address)).to.be.true;
        expect(await token.getMemberGrade(alice.address)).to.equal(0); // Student
    });

    it("joinDAO() traccia correttamente ethDeposited", async function () {
        // In precedenza si leggeva baseTokens; ora il mapping rilevante è ethDeposited.
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        expect(await token.ethDeposited(alice.address)).to.equal(ethers.parseEther("10"));
    });

    it("joinDAO() reverta senza ETH", async function () {
        await expect(
            token.connect(alice).joinDAO({ value: 0 })
        ).to.be.revertedWithCustomError(token, "ZeroDeposit");
    });

    it("joinDAO() reverta oltre 100 ETH", async function () {
        await expect(
            token.connect(alice).joinDAO({ value: ethers.parseEther("101") })
        ).to.be.revertedWithCustomError(token, "ExceedsMaxDeposit");
    });

    it("joinDAO() reverta se già membro", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("1") });
        await expect(
            token.connect(alice).joinDAO({ value: ethers.parseEther("1") })
        ).to.be.revertedWithCustomError(token, "AlreadyMember");
    });

    // ── Coefficienti competenza ──

    it("competenceScore restituisce i valori corretti", async function () {
        expect(await token.competenceScore(0)).to.equal(0); // Student
        expect(await token.competenceScore(1)).to.equal(25); // Bachelor
        expect(await token.competenceScore(2)).to.equal(50); // Master
        expect(await token.competenceScore(3)).to.equal(75); // PhD
        expect(await token.competenceScore(4)).to.equal(100); // Professor
    });

    // ── Delega e voting power ──

    it("senza delega, getVotes restituisce 0", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        expect(await token.getVotes(alice.address)).to.equal(0n);
    });

    it("dopo delegate(self), getVotes = balanceOf", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        await token.connect(alice).delegate(alice.address);
        expect(await token.getVotes(alice.address)).to.equal(await token.balanceOf(alice.address));
    });

    it("trasferimento aggiorna i checkpoint", async function () {
        // alice: joinDAO(10 ETH) → scoreSoldi=10 → 5 token
        // bob:   joinDAO(5 ETH)  → scoreSoldi=5  → 2.5 token
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        await token.connect(alice).delegate(alice.address);
        await token.connect(bob).joinDAO({ value: ethers.parseEther("5") });
        await token.connect(bob).delegate(bob.address);

        // Trasferisce 2 token da alice a bob
        const transferAmt = ethers.parseEther("2");
        await token.connect(alice).transfer(bob.address, transferAmt);

        // alice: 5 - 2 = 3 token
        // bob:   2.5 + 2 = 4.5 token
        expect(await token.getVotes(alice.address)).to.equal(ethers.parseEther("3"));
        expect(await token.getVotes(bob.address)).to.equal(ethers.parseEther("4.5"));
    });

    it("getPastVotes restituisce snapshot storici", async function () {
        // alice: joinDAO(10 ETH) → scoreSoldi=10 → 5 token
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        await token.connect(alice).delegate(alice.address);
        const blockBefore = await ethers.provider.getBlockNumber();
        await mine(1);

        await token.connect(alice).transfer(bob.address, ethers.parseEther("2"));
        await mine(1);

        // Snapshot prima del trasferimento: alice aveva 5 token
        expect(await token.getPastVotes(alice.address, blockBefore)).to.equal(ethers.parseEther("5"));
    });

    // ── upgradeCompetence access control ──

    it("upgradeCompetence reverta se non dal Timelock", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("1") });
        await expect(
            token.upgradeCompetence(alice.address, 4, "Professore")
        ).to.be.revertedWithCustomError(token, "OnlyTimelock");
    });

    // ── mintTokens() ──

    it("mintTokens() aggiunge i token VPC dell'incremento deposit", async function () {
        // alice joinDAO(1 ETH): scoreSoldi=1 → 0.5 token
        await token.connect(alice).joinDAO({ value: ethers.parseEther("1") }); // 0.5 token
        // mintTokens(2 ETH): oldDeposit=1 ETH, newDeposit=3 ETH
        //   oldScore=1, newScore=3, Δscore=2 → 2×5000/10000 = 1 token
        await token.connect(alice).mintTokens({ value: ethers.parseEther("2") });

        expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("1.5")); // 0.5 + 1
        expect(await token.ethDeposited(alice.address)).to.equal(ethers.parseEther("3"));
    });

    it("mintTokens() reverta se non membro", async function () {
        await expect(
            token.connect(alice).mintTokens({ value: ethers.parseEther("1") })
        ).to.be.revertedWithCustomError(token, "NotMember");
    });

    it("mintTokens() reverta senza ETH", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("1") });
        await expect(
            token.connect(alice).mintTokens({ value: 0 })
        ).to.be.revertedWithCustomError(token, "ZeroDeposit");
    });

    it("mintTokens() invia ETH al Treasury", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("1") });
        const balBefore = await treasury.getBalance();
        await token.connect(alice).mintTokens({ value: ethers.parseEther("2") });
        const balAfter = await treasury.getBalance();
        expect(balAfter - balBefore).to.equal(ethers.parseEther("2"));
    });
});

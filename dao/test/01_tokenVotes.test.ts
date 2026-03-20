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
        token = await Token.deploy(await timelock.getAddress());
        await token.waitForDeployment();

        const Treasury_ = await ethers.getContractFactory("Treasury");
        treasury = await Treasury_.deploy(await timelock.getAddress());
        await treasury.waitForDeployment();

        await token.setTreasury(await treasury.getAddress());
    });

    // ── joinDAO() ──

    it("joinDAO() minta 1.000 COMP per 1 ETH depositato", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("1") });
        expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("1000", 18));
    });

    it("joinDAO() minta 50.000 COMP per 50 ETH depositati", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("50") });
        expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("50000", 18));
    });

    it("joinDAO() registra il membro come Student", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        expect(await token.isMember(alice.address)).to.be.true;
        expect(await token.getMemberGrade(alice.address)).to.equal(0); // Student
    });

    it("joinDAO() salva i token base correttamente", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        expect(await token.baseTokens(alice.address)).to.equal(ethers.parseUnits("10000", 18));
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
        expect(await token.competenceScore(0)).to.equal(1); // Student
        expect(await token.competenceScore(1)).to.equal(2); // Bachelor
        expect(await token.competenceScore(2)).to.equal(3); // Master
        expect(await token.competenceScore(3)).to.equal(4); // PhD
        expect(await token.competenceScore(4)).to.equal(5); // Professor
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
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        await token.connect(alice).delegate(alice.address);
        await token.connect(bob).joinDAO({ value: ethers.parseEther("5") });
        await token.connect(bob).delegate(bob.address);

        const transferAmt = ethers.parseUnits("2000", 18);
        await token.connect(alice).transfer(bob.address, transferAmt);

        expect(await token.getVotes(alice.address)).to.equal(ethers.parseUnits("8000", 18));
        expect(await token.getVotes(bob.address)).to.equal(ethers.parseUnits("7000", 18));
    });

    it("getPastVotes restituisce snapshot storici", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        await token.connect(alice).delegate(alice.address);
        const blockBefore = await ethers.provider.getBlockNumber();
        await mine(1);

        await token.connect(alice).transfer(bob.address, ethers.parseUnits("2000", 18));
        await mine(1);

        expect(await token.getPastVotes(alice.address, blockBefore)).to.equal(ethers.parseUnits("10000", 18));
    });

    // ── upgradeCompetence access control ──

    it("upgradeCompetence reverta se non dal Timelock", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("1") });
        await expect(
            token.upgradeCompetence(alice.address, 4, "Professore")
        ).to.be.revertedWithCustomError(token, "OnlyTimelock");
    });

    // ── mintTokens() ──

    it("mintTokens() minta token con moltiplicatore Student (×1)", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("1") }); // 1.000 COMP
        await token.connect(alice).mintTokens({ value: ethers.parseEther("2") }); // 2.000 × 1 = 2.000

        expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("3000", 18));
        expect(await token.baseTokens(alice.address)).to.equal(ethers.parseUnits("3000", 18));
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

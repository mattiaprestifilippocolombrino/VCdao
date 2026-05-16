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
    it("joinDAO() minta i token VPC corretti per 1 ETH", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("1") });
        expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("0.5"));
    });

    it("joinDAO() minta i token VPC corretti per 50 ETH", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("50") });
        expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("25"));
    });

    it("joinDAO() registra il membro come Student", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        expect(await token.isMember(alice.address)).to.be.true;
        expect(await token.getMemberGrade(alice.address)).to.equal(0);
    });

    it("joinDAO() traccia correttamente stakeDeposited", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        expect(await token.stakeDeposited(alice.address)).to.equal(ethers.parseEther("10"));
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

    // ── Delega e voting power ──
    it("senza delega, getVotes restituisce 0", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        expect(await token.getVotes(alice.address)).to.equal(0n);
    });

    it("dopo delega a se stessi, getVotes = balanceOf", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        await token.connect(alice).delegate(alice.address);
        expect(await token.getVotes(alice.address)).to.equal(await token.balanceOf(alice.address));
    });

    it("trasferimento aggiorna i checkpoint (con delega attiva)", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        await token.connect(bob).joinDAO({ value: ethers.parseEther("5") });
        
        await token.connect(alice).delegate(alice.address);
        await token.connect(bob).delegate(bob.address);

        const transferAmt = ethers.parseEther("2");
        await token.connect(alice).transfer(bob.address, transferAmt);

        expect(await token.getVotes(alice.address)).to.equal(ethers.parseEther("3"));
        expect(await token.getVotes(bob.address)).to.equal(ethers.parseEther("4.5"));
    });

    it("getPastVotes restituisce snapshot storici (con delega attiva)", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
        await token.connect(alice).delegate(alice.address);
        const blockBefore = await ethers.provider.getBlockNumber();
        await mine(1);

        await token.connect(alice).transfer(bob.address, ethers.parseEther("2"));
        await mine(1);

        expect(await token.getPastVotes(alice.address, blockBefore)).to.equal(ethers.parseEther("5"));
    });

    // ── upgradeSkill access control ──
    it("upgradeSkill reverta se non dal Timelock", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("1") });
        await expect(
            token.upgradeSkill(alice.address, 4, hashLegacyProof("Professore"))
        ).to.be.revertedWithCustomError(token, "OnlyTimelock");
    });

    // ── increaseStake() ──
    it("increaseStake() aggiunge i token VPC", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("1") }); 
        await token.connect(alice).increaseStake({ value: ethers.parseEther("2") });
        expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("1.5"));
        expect(await token.stakeDeposited(alice.address)).to.equal(ethers.parseEther("3"));
    });

    it("increaseStake() reverta se non membro", async function () {
        await expect(
            token.connect(alice).increaseStake({ value: ethers.parseEther("1") })
        ).to.be.revertedWithCustomError(token, "NotMember");
    });

    it("increaseStake() reverta senza ETH", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("1") });
        await expect(
            token.connect(alice).increaseStake({ value: 0 })
        ).to.be.revertedWithCustomError(token, "ZeroDeposit");
    });

    it("increaseStake() invia ETH al Treasury", async function () {
        await token.connect(alice).joinDAO({ value: ethers.parseEther("1") });
        const balBefore = await treasury.getBalance();
        await token.connect(alice).increaseStake({ value: ethers.parseEther("2") });
        const balAfter = await treasury.getBalance();
        expect(balAfter - balBefore).to.equal(ethers.parseEther("2"));
    });
});

function hashLegacyProof(proof: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(proof));
}

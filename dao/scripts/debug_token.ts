import { ethers } from "hardhat";
import { GovernanceToken, TimelockController } from "../typechain-types";

async function main() {
    const [deployer] = await ethers.getSigners();

    const Timelock = await ethers.getContractFactory("TimelockController");
    const timelock = await Timelock.deploy(3600, [], [], deployer.address);
    await timelock.waitForDeployment();

    const Token = await ethers.getContractFactory("GovernanceToken");
    const token = await Token.deploy(await timelock.getAddress(), 5000n, 5000n);
    await token.waitForDeployment();

    console.log("pesoCompetenze:", await token.pesoCompetenze());
    console.log("pesoSoldi:", await token.pesoSoldi());
    console.log("score Student (0):", await token.competenceScore(0));
    console.log("score PhD (3):", await token.competenceScore(3));
}

main().catch(console.error);

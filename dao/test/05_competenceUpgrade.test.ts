// ============================================================================
//  05_competenceUpgrade.test.ts — Upgrade competenza via governance + VP EIP-712
// ============================================================================

import { expect } from "chai";
import { ethers } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import { GovernanceToken, MyGovernor, Treasury, TimelockController } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Competence Upgrade — via governance", function () {
    let token: GovernanceToken;
    let treasury: Treasury;
    let timelock: TimelockController;
    let governor: MyGovernor;
    let deployer: HardhatEthersSigner;
    let member: HardhatEthersSigner;
    let issuer: HardhatEthersSigner;

    const VOTING_DELAY = 1;
    const VOTING_PERIOD = 50;
    const TIMELOCK_DELAY = 3600;

    // Tipi EIP-712 per la VerifiableCredential (devono corrispondere a VPVerifier.sol)
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

    beforeEach(async function () {
        [deployer, member, issuer] = await ethers.getSigners();

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
        await token.setTrustedIssuer(issuer.address);

        await token.joinDAO({ value: ethers.parseEther("10") }); // 10.000 COMP
        await token.delegate(deployer.address);

        const Governor = await ethers.getContractFactory("MyGovernor");
        governor = await Governor.deploy(
            await token.getAddress(), await timelock.getAddress(),
            VOTING_DELAY, VOTING_PERIOD, 0, 20, 70
        );
        await governor.waitForDeployment();

        const governorAddr = await governor.getAddress();
        await timelock.grantRole(await timelock.PROPOSER_ROLE(), governorAddr);
        await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
        await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);

        // Il membro entra con 5 ETH → 5.000 COMP base
        await token.connect(member).joinDAO({ value: ethers.parseEther("5") });
        await token.connect(member).delegate(member.address);
        await mine(1);
    });

    // =========================================================================
    //  Helper: esegue un upgrade completo via governance (legacy)
    // =========================================================================
    async function doUpgrade(target: HardhatEthersSigner, grade: number, proof: string) {
        const tokenAddr = await token.getAddress();
        const calldata = token.interface.encodeFunctionData("upgradeCompetence", [
            target.address, grade, proof
        ]);
        const targets = [tokenAddr];
        const values = [0n];
        const calldatas = [calldata];
        const description = `Upgrade ${target.address} a grado ${grade}: ${proof}`;

        const tx = await governor.propose(targets, values, calldatas, description);
        const receipt = await tx.wait();
        const proposalId = receipt!.logs
            .map((log: any) => { try { return governor.interface.parseLog(log); } catch { return null; } })
            .find((p: any) => p?.name === "ProposalCreated")?.args?.proposalId;

        await mine(VOTING_DELAY + 1);
        await governor.castVote(proposalId, 1);
        await mine(VOTING_PERIOD + 1);

        const descHash = ethers.id(description);
        await governor.queue(targets, values, calldatas, descHash);
        await time.increase(TIMELOCK_DELAY + 1);
        await governor.execute(targets, values, calldatas, descHash);
    }

    // =========================================================================
    //  Helper: costruisce il dominio EIP-712 Universale
    // =========================================================================
    async function getEIP712Domain() {
        return {
            name: "Universal VC Protocol",
            version: "1",
        };
    }

    // =========================================================================
    //  Helper: firma una VC con EIP-712 e esegue l'upgrade DIRETTAMENTE
    //  Best practice SSI: il membro presenta la propria VC senza governance
    // =========================================================================
    async function doUpgradeWithVP(
        target: HardhatEthersSigner,
        degreeTitle: string,
        holderDid: string,
        issuerDid: string,
        signer: HardhatEthersSigner = issuer
    ) {
        const domain = await getEIP712Domain();

        const vcData = {
            issuer: {
                id: issuerDid,
            },
            issuanceDate: "2026-01-01T00:00:00Z",
            credentialSubject: {
                id: holderDid,
                university: "University of Pisa",
                faculty: "Computer Science",
                degreeTitle: degreeTitle,
                grade: "110/110"
            },
        };

        // L'Issuer firma la VC con EIP-712
        const signature = await signer.signTypedData(domain, VC_TYPES, vcData);

        // Il membro presenta direttamente la propria VC — Self-Sovereign, nessun voto
        await token.connect(target).upgradeCompetenceWithVP(vcData, signature);
    }

    // =========================================================================
    //  Test legacy (retrocompatibilità)
    // =========================================================================

    it("upgrade legacy da Student a PhD: 5.000 × (4-1) = 15.000 aggiuntivi → 20.000 totali", async function () {
        await doUpgrade(member, 3, "PhD in AI, Politecnico di Milano, 2024");

        expect(await token.balanceOf(member.address)).to.equal(ethers.parseUnits("20000", 18));
        expect(await token.getMemberGrade(member.address)).to.equal(3); // PhD
        expect(await token.competenceProof(member.address)).to.equal("PhD in AI, Politecnico di Milano, 2024");
    });

    it("upgrade legacy da Student a Professor: 5.000 × (5-1) = 20.000 aggiuntivi → 25.000 totali", async function () {
        await doUpgrade(member, 4, "Professore Ordinario, UniMi");

        expect(await token.balanceOf(member.address)).to.equal(ethers.parseUnits("25000", 18));
        expect(await token.getMemberGrade(member.address)).to.equal(4);
    });

    it("non è possibile fare downgrade (legacy)", async function () {
        await doUpgrade(member, 3, "PhD");

        const tokenAddr = await token.getAddress();
        const calldata = token.interface.encodeFunctionData("upgradeCompetence", [
            member.address, 1, "Downgrade a Bachelor"
        ]);
        const targets = [tokenAddr];
        const values = [0n];
        const calldatas = [calldata];
        const description = "Tentativo downgrade";

        const tx = await governor.propose(targets, values, calldatas, description);
        const receipt = await tx.wait();
        const proposalId = receipt!.logs
            .map((log: any) => { try { return governor.interface.parseLog(log); } catch { return null; } })
            .find((p: any) => p?.name === "ProposalCreated")?.args?.proposalId;

        await mine(VOTING_DELAY + 1);
        await governor.castVote(proposalId, 1);
        await mine(VOTING_PERIOD + 1);

        const descHash = ethers.id(description);
        await governor.queue(targets, values, calldatas, descHash);
        await time.increase(TIMELOCK_DELAY + 1);

        await expect(
            governor.execute(targets, values, calldatas, descHash)
        ).to.be.reverted;
    });

    // =========================================================================
    //  Test DID registration (binding 1:1)
    // =========================================================================

    it("un membro può registrare il proprio DID", async function () {
        const did = "did:ethr:sepolia:0x" + member.address.slice(2);
        await token.connect(member).registerDID(did);

        expect(await token.memberDID(member.address)).to.equal(did);
        expect(await token.didToAddress(ethers.keccak256(ethers.toUtf8Bytes(did))))
            .to.equal(member.address);
    });

    it("un non-membro non può registrare un DID", async function () {
        const [, , , nonMember] = await ethers.getSigners();
        const did = "did:ethr:sepolia:0x" + nonMember.address.slice(2);
        await expect(token.connect(nonMember).registerDID(did))
            .to.be.revertedWithCustomError(token, "NotMember");
    });

    it("un membro non può registrare due volte un DID", async function () {
        const did = "did:ethr:sepolia:0x" + member.address.slice(2);
        await token.connect(member).registerDID(did);
        await expect(token.connect(member).registerDID("did:ethr:other"))
            .to.be.revertedWithCustomError(token, "DIDAlreadyRegistered");
    });

    it("due membri non possono registrare lo stesso DID", async function () {
        const did = "did:ethr:sepolia:shared";
        await token.connect(member).registerDID(did);

        // Il deployer è anch'esso membro (ha fatto joinDAO nel beforeEach)
        await expect(token.connect(deployer).registerDID(did))
            .to.be.revertedWithCustomError(token, "DIDAlreadyBound");
    });

    // =========================================================================
    //  Test VP-based upgrade (core della tesi)
    // =========================================================================

    it("upgrade con VP valida: Student → PhD (5.000 × 3 = 15.000 aggiuntivi)", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);

        // Registra il DID del membro
        await token.connect(member).registerDID(holderDid);

        // Esegui upgrade con VP firmata EIP-712
        await doUpgradeWithVP(member, "PhD", holderDid, issuerDid);

        expect(await token.balanceOf(member.address)).to.equal(ethers.parseUnits("20000", 18));
        expect(await token.getMemberGrade(member.address)).to.equal(3); // PhD
        expect(await token.competenceProof(member.address)).to.contain("VP-EIP712:");
    });

    it("upgrade con VP: Student → MasterDegree (5.000 × 2 = 10.000 aggiuntivi)", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);

        await token.connect(member).registerDID(holderDid);
        await doUpgradeWithVP(member, "MasterDegree", holderDid, issuerDid);

        expect(await token.balanceOf(member.address)).to.equal(ethers.parseUnits("15000", 18));
        expect(await token.getMemberGrade(member.address)).to.equal(2);
    });

    it("upgrade con VP: Student → Professor (5.000 × 4 = 20.000 aggiuntivi)", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);

        await token.connect(member).registerDID(holderDid);
        await doUpgradeWithVP(member, "Professor", holderDid, issuerDid);

        expect(await token.balanceOf(member.address)).to.equal(ethers.parseUnits("25000", 18));
        expect(await token.getMemberGrade(member.address)).to.equal(4);
    });

    it("rifiuta VP con degreeTitle non consentito", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);

        await token.connect(member).registerDID(holderDid);
        await expect(
            doUpgradeWithVP(member, "SimpleStudent", holderDid, issuerDid)
        ).to.be.reverted; // InvalidDegreeLevel
    });

    it("rifiuta VP con issuer non fidato", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const fakeDid = "did:ethr:sepolia:0xFAKE";
        const [, , , fakeIssuer] = await ethers.getSigners();

        await token.connect(member).registerDID(holderDid);

        // Firma con un signer diverso dall'issuer fidato
        await expect(
            doUpgradeWithVP(member, "PhD", holderDid, fakeDid, fakeIssuer)
        ).to.be.reverted; // UntrustedIssuer al momento dell'execute
    });

    it("rifiuta VP con DID non registrato", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);

        // NON registriamo il DID → NoDIDRegistered
        await expect(
            doUpgradeWithVP(member, "PhD", holderDid, issuerDid)
        ).to.be.reverted;
    });

    it("rifiuta VP con DID che non corrisponde al membro", async function () {
        const wrongDid = "did:ethr:sepolia:0xWRONG";
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);

        // Registra un DID diverso da quello nella VC
        await token.connect(member).registerDID("did:ethr:sepolia:0xREAL");

        await expect(
            doUpgradeWithVP(member, "PhD", wrongDid, issuerDid)
        ).to.be.reverted; // DIDMismatch
    });

    it("il membro upgraded con VP ha più voting power", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);

        await token.connect(member).registerDID(holderDid);

        const votesBefore = await token.getVotes(member.address);
        await doUpgradeWithVP(member, "PhD", holderDid, issuerDid);
        await token.connect(member).delegate(member.address); // Re-delega

        const votesAfter = await token.getVotes(member.address);
        expect(votesAfter).to.be.greaterThan(votesBefore);
        expect(votesAfter).to.equal(ethers.parseUnits("20000", 18));
    });
});

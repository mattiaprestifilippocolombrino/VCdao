// ============================================================================
//  05_competenceUpgrade.test.ts — Upgrade skill array via VC EIP-712
//  Nuova architettura: ogni utente accumula un array di skill eterogenee.
//  Il calcolo del VP è delegato a SkillCalculator (contratto esterno).
// ============================================================================

import { expect } from "chai";
import { ethers } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import {
    GovernanceToken,
    MyGovernor,
    Treasury,
    TimelockController,
    SkillCalculator,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Competence Upgrade — skill array + SkillCalculator", function () {
    let token: GovernanceToken;
    let treasury: Treasury;
    let timelock: TimelockController;
    let governor: MyGovernor;
    let calculator: SkillCalculator;
    let deployer: HardhatEthersSigner;
    let member: HardhatEthersSigner;
    let issuer: HardhatEthersSigner;
    let secondIssuer: HardhatEthersSigner;

    const VOTING_DELAY  = 1;
    const VOTING_PERIOD = 50;
    const TIMELOCK_DELAY = 3600;

    // Tipi EIP-712 aggiornati: CredentialSubject ha skills[] invece di degreeTitle/grade
    const VC_TYPES = {
        Issuer: [{ name: "id", type: "string" }],
        CredentialSubject: [
            { name: "id",         type: "string"   },
            { name: "university", type: "string"   },
            { name: "faculty",    type: "string"   },
            { name: "skills",     type: "string[]" },
        ],
        VerifiableCredential: [
            { name: "issuer",             type: "Issuer"            },
            { name: "issuanceDate",       type: "string"            },
            { name: "credentialSubject",  type: "CredentialSubject" },
        ],
    };

    // Domain EIP-712 universale (deve coincidere con UNIVERSAL_DOMAIN_SEPARATOR)
    const EIP712_DOMAIN = { name: "Universal VC Protocol", version: "1" };
    const skill = (name: string) => ethers.id(name);
    const skillIds = (names: string[]) => names.map(skill);

    // =========================================================================
    //  beforeEach: deploy completo con SkillCalculator
    // =========================================================================
    beforeEach(async function () {
        [deployer, member, issuer, secondIssuer] = await ethers.getSigners();

        // 1. Timelock
        const Timelock = await ethers.getContractFactory("TimelockController");
        timelock = await Timelock.deploy(TIMELOCK_DELAY, [], [], deployer.address);
        await timelock.waitForDeployment();

        // 2. GovernanceToken
        const Token = await ethers.getContractFactory("GovernanceToken");
        token = await Token.deploy(await timelock.getAddress(), 5000n, 5000n);
        await token.waitForDeployment();

        // 3. Treasury
        const Treasury_ = await ethers.getContractFactory("Treasury");
        treasury = await Treasury_.deploy(await timelock.getAddress());
        await treasury.waitForDeployment();

        // 4. SkillCalculator — contratto esterno (0 SLOAD, logica pure)
        const Calculator = await ethers.getContractFactory("SkillCalculator");
        calculator = await Calculator.deploy();
        await calculator.waitForDeployment();

        // 5. Setup token
        await token.setTreasury(await treasury.getAddress());
        await token.setTrustedIssuer(issuer.address);
        await token.setSkillCalculator(await calculator.getAddress());

        // 6. Fondatore (deployer) entra e delega
        await token.joinDAO({ value: ethers.parseEther("100") });
        await token.delegate(deployer.address);

        // 7. Governor
        const Governor = await ethers.getContractFactory("MyGovernor");
        governor = await Governor.deploy(
            await token.getAddress(), await timelock.getAddress(),
            VOTING_DELAY, VOTING_PERIOD, 0, 20, 70
        );
        await governor.waitForDeployment();

        const governorAddr = await governor.getAddress();
        await timelock.grantRole(await timelock.PROPOSER_ROLE(),  governorAddr);
        await timelock.grantRole(await timelock.EXECUTOR_ROLE(),  ethers.ZeroAddress);
        await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);

        // 8. Il membro entra con 5 ETH e delega
        await token.connect(member).joinDAO({ value: ethers.parseEther("5") });
        await token.connect(member).delegate(member.address);
        await mine(1);
    });

    // =========================================================================
    //  Helper: firma e invia una VC con array di skill
    // =========================================================================
    async function doUpgradeWithVC(
        target: HardhatEthersSigner,
        skills: string[],
        holderDid: string,
        issuerDid: string,
        signer: HardhatEthersSigner = issuer
    ) {
        const vcData = {
            issuer: { id: issuerDid },
            issuanceDate: "2026-01-01T00:00:00Z",
            credentialSubject: {
                id: holderDid,
                university: "University of Pisa",
                faculty: "Computer Science",
                skills: skills,
            },
        };
        const signature = await signer.signTypedData(EIP712_DOMAIN, VC_TYPES, vcData);
        await token.connect(target).upgradeSkillWithVC(vcData, signature);
        return vcData;
    }

    // =========================================================================
    //  Helper: governance legacy (upgradeSkill dal Timelock via proposta)
    // =========================================================================
    async function doUpgradeViaGovernance(
        target: HardhatEthersSigner,
        skills: string[],
        proof: string,
        topicId: number
    ) {
        const tokenAddr = await token.getAddress();
        const calldata = token.interface.encodeFunctionData("upgradeSkill", [
            target.address, skillIds(skills), proof,
        ]);
        const description = `Upgrade ${target.address.slice(0, 8)} skills:${skills.join(",")}`;
        const tx = await governor.proposeWithTopic([tokenAddr], [0n], [calldata], description, topicId);
        const receipt = await tx.wait();
        const proposalId = receipt!.logs
            .map((l: any) => { try { return governor.interface.parseLog(l); } catch { return null; } })
            .find((p: any) => p?.name === "ProposalCreated")?.args?.proposalId;

        await mine(VOTING_DELAY + 1);
        await governor.castVote(proposalId, 1);
        await mine(VOTING_PERIOD + 1);

        const descHash = ethers.id(description);
        await governor.queue([tokenAddr], [0n], [calldata], descHash);
        await time.increase(TIMELOCK_DELAY + 1);
        await governor.execute([tokenAddr], [0n], [calldata], descHash);
    }

    async function addTrustedIssuerThroughTimelock(newIssuer: string) {
        const timelockAddr = await timelock.getAddress();
        await deployer.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });
        await ethers.provider.send("hardhat_impersonateAccount", [timelockAddr]);
        try {
            const timelockSigner = await ethers.getSigner(timelockAddr);
            await token.connect(timelockSigner).setTrustedIssuer(newIssuer);
        } finally {
            await ethers.provider.send("hardhat_stopImpersonatingAccount", [timelockAddr]);
        }
    }

    async function removeTrustedIssuerThroughTimelock(oldIssuer: string) {
        const timelockAddr = await timelock.getAddress();
        await deployer.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });
        await ethers.provider.send("hardhat_impersonateAccount", [timelockAddr]);
        try {
            const timelockSigner = await ethers.getSigner(timelockAddr);
            return await token.connect(timelockSigner).removeTrustedIssuer(oldIssuer);
        } finally {
            await ethers.provider.send("hardhat_stopImpersonatingAccount", [timelockAddr]);
        }
    }

    // =========================================================================
    //  Test: configurazione contratto
    // =========================================================================
    it("SkillCalculator è correttamente linkato al GovernanceToken", async function () {
        expect(await token.skillCalculator()).to.equal(await calculator.getAddress());
    });

    it("isValidTopic() riflette i topic del SkillCalculator (0,1,2,3 validi; 4 no)", async function () {
        expect(await token.isValidTopic(0)).to.be.true;
        expect(await token.isValidTopic(1)).to.be.true;
        expect(await token.isValidTopic(2)).to.be.true;
        expect(await token.isValidTopic(3)).to.be.true;
        expect(await token.isValidTopic(4)).to.be.false;
    });

    it("setSkillCalculator() richiede il Timelock dopo la prima configurazione", async function () {
        await expect(
            token.connect(member).setSkillCalculator(await calculator.getAddress())
        ).to.be.revertedWithCustomError(token, "OnlyTimelock");
    });

    it("supporta un insieme di trusted issuer", async function () {
        await addTrustedIssuerThroughTimelock(secondIssuer.address);

        expect(await token.trustedIssuers(issuer.address)).to.equal(true);
        expect(await token.trustedIssuers(secondIssuer.address)).to.equal(true);
        expect(await token.trustedIssuerCount()).to.equal(2n);
    });

    it("rimuove un trusted issuer senza usare una lista on-chain", async function () {
        await addTrustedIssuerThroughTimelock(secondIssuer.address);
        await removeTrustedIssuerThroughTimelock(secondIssuer.address);

        expect(await token.trustedIssuers(secondIssuer.address)).to.equal(false);
        expect(await token.trustedIssuerCount()).to.equal(1n);
    });

    it("non permette di rimuovere l'ultimo trusted issuer", async function () {
        await expect(
            removeTrustedIssuerThroughTimelock(issuer.address)
        ).to.be.revertedWithCustomError(token, "CannotRemoveLastTrustedIssuer");
    });

    // =========================================================================
    //  Test: SkillCalculator puro (logica di scoring)
    // =========================================================================
    it("SkillCalculator calcola score corretto per skill singola 'smart-contracts' su Web3", async function () {
        const score = await calculator.calculateVP(0, skillIds(["smart-contracts"]));
        expect(score).to.equal(40n);
    });

    it("SkillCalculator calcola score corretto per skill singola 'digital-health' su Digital Health", async function () {
        const score = await calculator.calculateVP(2, skillIds(["digital-health"]));
        expect(score).to.equal(45n);
    });

    it("SkillCalculator applica boost machine-learning+data-analysis su AI Products", async function () {
        const scoreCombo = await calculator.calculateVP(1, skillIds(["machine-learning", "data-analysis"]));
        expect(scoreCombo).to.equal(90n);
    });

    it("SkillCalculator applica boost smart-contracts+tokenomics su Web3", async function () {
        const scoreCombo = await calculator.calculateVP(0, skillIds(["smart-contracts", "tokenomics"]));
        expect(scoreCombo).to.equal(95n);
    });

    it("SkillCalculator applica boost digital-health+data-analysis su Digital Health", async function () {
        const scoreCombo = await calculator.calculateVP(2, skillIds(["digital-health", "data-analysis"]));
        expect(scoreCombo).to.equal(85n);
    });

    it("SkillCalculator cappa il punteggio a 100", async function () {
        const score = await calculator.calculateVP(0, skillIds(["smart-contracts", "tokenomics", "machine-learning"]));
        expect(score).to.equal(100n);
    });

    it("SkillCalculator ignora skill duplicate nello stesso array", async function () {
        const score = await calculator.calculateVP(0, skillIds(["smart-contracts", "smart-contracts"]));
        expect(score).to.equal(40n);
    });

    // =========================================================================
    //  Test: DID registration
    // =========================================================================
    it("un membro può registrare il proprio DID", async function () {
        const did = "did:ethr:sepolia:0x" + member.address.slice(2);
        await token.connect(member).registerDID(did);
        expect(await token.memberDID(member.address)).to.equal(did);
        expect(await token.didToAddress(ethers.keccak256(ethers.toUtf8Bytes(did)))).to.equal(member.address);
    });

    it("un non-membro non può registrare un DID", async function () {
        const [, , , nonMember] = await ethers.getSigners();
        await expect(
            token.connect(nonMember).registerDID("did:ethr:test:0xABC")
        ).to.be.revertedWithCustomError(token, "NotMember");
    });

    it("due membri non possono registrare lo stesso DID", async function () {
        const did = "did:ethr:sepolia:shared";
        await token.connect(member).registerDID(did);
        await expect(
            token.connect(deployer).registerDID(did)
        ).to.be.revertedWithCustomError(token, "DIDAlreadyBound");
    });

    // =========================================================================
    //  Test: upgradeSkillWithVC
    // =========================================================================
    it("upgrade con VC: salva le skill nel membro e aggiorna i checkpoint", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
        await token.connect(member).registerDID(holderDid);

        await doUpgradeWithVC(member, ["smart-contracts", "machine-learning"], holderDid, issuerDid);

        const skills = await token.getMemberSkills(member.address);
        expect(skills).to.include(skill("smart-contracts"));
        expect(skills).to.include(skill("machine-learning"));
    });

    it("upgrade con VC: aggiorna correttamente il checkpoint Web3", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
        await token.connect(member).registerDID(holderDid);

        await doUpgradeWithVC(member, ["smart-contracts"], holderDid, issuerDid);
        expect(await token.getSkillVotes(member.address, 0)).to.equal(ethers.parseEther("20"));
    });

    it("upgrade con VC: score Digital Health per digital-health = 45 → 22.5 VP skill", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
        await token.connect(member).registerDID(holderDid);

        await doUpgradeWithVC(member, ["digital-health"], holderDid, issuerDid);
        expect(await token.getSkillVotes(member.address, 2)).to.equal(ethers.parseEther("22.5"));
    });

    it("secondo upgrade con nuove skill: accumula le skill senza duplicati", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
        await token.connect(member).registerDID(holderDid);

        await doUpgradeWithVC(member, ["smart-contracts"], holderDid, issuerDid);
        await doUpgradeWithVC(member, ["smart-contracts", "machine-learning"], holderDid, issuerDid);

        const skills = await token.getMemberSkills(member.address);
        expect(skills.filter((s: string) => s === skill("smart-contracts")).length).to.equal(1);
        expect(skills).to.include(skill("machine-learning"));
    });

    it("secondo upgrade con nuove skill: aumenta il checkpoint (delta cumulativo)", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
        await token.connect(member).registerDID(holderDid);

        await doUpgradeWithVC(member, ["smart-contracts"], holderDid, issuerDid);
        const vpAfterFirst = await token.getSkillVotes(member.address, 0);

        await doUpgradeWithVC(member, ["smart-contracts", "machine-learning"], holderDid, issuerDid);
        const vpAfterSecond = await token.getSkillVotes(member.address, 0);

        expect(vpAfterSecond).to.be.greaterThan(vpAfterFirst);
    });

    it("boost combinazionale si riflette nel checkpoint: smart-contracts+tokenomics su Web3", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
        await token.connect(member).registerDID(holderDid);

        await doUpgradeWithVC(member, ["smart-contracts", "tokenomics"], holderDid, issuerDid);
        expect(await token.getSkillVotes(member.address, 0)).to.equal(ethers.parseEther("47.5"));
    });

    it("rifiuta VC con issuer non fidato", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const [, , , fakeIssuer] = await ethers.getSigners();
        await token.connect(member).registerDID(holderDid);

        await expect(
            doUpgradeWithVC(member, ["smart-contracts"], holderDid, "did:ethr:fake", fakeIssuer)
        ).to.be.revertedWithCustomError(token, "UntrustedIssuer");
    });

    it("accetta VC firmate da un secondo trusted issuer", async function () {
        await addTrustedIssuerThroughTimelock(secondIssuer.address);

        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + secondIssuer.address.slice(2);
        await token.connect(member).registerDID(holderDid);

        await doUpgradeWithVC(member, ["backend-java"], holderDid, issuerDid, secondIssuer);
        expect(await token.getSkillVotes(member.address, 3)).to.equal(ethers.parseEther("20"));
    });

    it("rifiuta VC con DID non registrato", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
        // NON registriamo il DID
        await expect(
            doUpgradeWithVC(member, ["smart-contracts"], holderDid, issuerDid)
        ).to.be.revertedWithCustomError(token, "NoDIDRegistered");
    });

    it("rifiuta VC con DID mismatch", async function () {
        const wrongDid = "did:ethr:sepolia:0xWRONG";
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
        await token.connect(member).registerDID("did:ethr:sepolia:0xREAL");

        await expect(
            doUpgradeWithVC(member, ["smart-contracts"], wrongDid, issuerDid)
        ).to.be.revertedWithCustomError(token, "DIDMismatch");
    });

    it("rifiuta VC se SkillCalculator non è impostato", async function () {
        // Deploy nuovo token senza calculator
        const Timelock2 = await ethers.getContractFactory("TimelockController");
        const tl2 = await Timelock2.deploy(3600, [], [], deployer.address);
        await tl2.waitForDeployment();
        const Token2 = await ethers.getContractFactory("GovernanceToken");
        const token2 = await Token2.deploy(await tl2.getAddress(), 5000n, 5000n);
        await token2.waitForDeployment();

        const Treasury2_ = await ethers.getContractFactory("Treasury");
        const treasury2 = await Treasury2_.deploy(await tl2.getAddress());
        await treasury2.waitForDeployment();
        await token2.setTreasury(await treasury2.getAddress());
        await token2.setTrustedIssuer(issuer.address);
        // Nessun setSkillCalculator

        await token2.connect(member).joinDAO({ value: ethers.parseEther("1") });
        const did = "did:ethr:test:member";
        await token2.connect(member).registerDID(did);

        const vcData = {
            issuer: { id: "did:ethr:issuer" },
            issuanceDate: "2026-01-01T00:00:00Z",
            credentialSubject: { id: did, university: "UniPI", faculty: "Computer Science", skills: ["smart-contracts"] },
        };
        const signature = await issuer.signTypedData(EIP712_DOMAIN, VC_TYPES, vcData);
        await expect(
            token2.connect(member).upgradeSkillWithVC(vcData, signature)
        ).to.be.revertedWithCustomError(token2, "CalculatorNotSet");
    });

    // =========================================================================
    //  Test: governance legacy upgradeSkill (via proposta)
    // =========================================================================
    it("upgradeSkill via governance: aggiunge skill e aggiorna checkpoint", async function () {
        await doUpgradeViaGovernance(member, ["backend-java", "tokenomics"], "Approvato da governance", 0);

        const skills = await token.getMemberSkills(member.address);
        expect(skills).to.include(skill("backend-java"));
        expect(skills).to.include(skill("tokenomics"));
        expect(await token.getSkillVotes(member.address, 0)).to.equal(ethers.parseEther("20"));
    });

    // =========================================================================
    //  Test: stake + skill VP correnti
    // =========================================================================
    it("stake VP e skill VP restano separati nei moduli corretti", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
        await token.connect(member).registerDID(holderDid);

        // Stake: 5 ETH → 2.5 COMP
        const stakeVP = await token.balanceOf(member.address);

        await doUpgradeWithVC(member, ["smart-contracts"], holderDid, issuerDid);
        const totalVP = stakeVP + await token.getSkillVotes(member.address, 0);
        expect(totalVP).to.equal(stakeVP + ethers.parseEther("20"));
    });

    // =========================================================================
    //  Test: getPastSkillVotes (snapshot invarianza)
    // =========================================================================
    it("getPastSkillVotes: upgrade successivo non altera snapshot precedente", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
        await token.connect(member).registerDID(holderDid);

        await doUpgradeWithVC(member, ["smart-contracts"], holderDid, issuerDid);
        const snapshot = await ethers.provider.getBlockNumber();
        await mine(1);

        // Secondo upgrade con skill aggiuntive
        await doUpgradeWithVC(member, ["smart-contracts", "machine-learning"], holderDid, issuerDid);

        // Il VP allo snapshot deve riflettere solo il primo upgrade
        const pastVP = await token.getPastSkillVotes(member.address, 0, snapshot);
        expect(pastVP).to.equal(ethers.parseEther("20"));
    });
});

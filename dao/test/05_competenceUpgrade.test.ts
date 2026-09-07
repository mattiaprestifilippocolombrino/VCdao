// ============================================================================
//  05_competenceUpgrade.test.ts — Upgrade skill bitmap via VC EIP-712
//  Ogni utente accumula skill in una bitmap; le VC mantengono i nomi testuali.
//  Il calcolo del VP è delegato a SkillCalculator (contratto esterno).
// ============================================================================

import { expect } from "chai";
import { ethers } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import {
    GovernanceSkill,
    GovernanceToken,
    MyGovernor,
    Treasury,
    TimelockController,
    SkillCalculator,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
    EIP712_DOMAIN,
    LoadedCredential,
    loadCredentialForAddress,
    loadSharedCredentials,
} from "./helpers/sharedCredentials";

describe("Competence Upgrade — skill bitmap + SkillCalculator", function () {
    let token: GovernanceToken;
    let skillModule: GovernanceSkill;
    let treasury: Treasury;
    let timelock: TimelockController;
    let governor: MyGovernor;
    let calculator: SkillCalculator;
    let deployer: HardhatEthersSigner;
    let member: HardhatEthersSigner;
    let issuer: HardhatEthersSigner;
    let secondIssuer: HardhatEthersSigner;
    let memberCredential: LoadedCredential;

    const VOTING_DELAY  = 1;
    const VOTING_PERIOD = 50;
    const TIMELOCK_DELAY = 3600;

    const skill = (name: string) => ethers.id(name);
    const skillIds = (names: string[]) => names.map(skill);

    async function scoreForTopic(topicId: number, skills: string[]) {
        const scores = await calculator.calculateAllVP(skillIds(skills));
        return scores[topicId];
    }

    // =========================================================================
    //  beforeEach: deploy completo con SkillCalculator
    // =========================================================================
    beforeEach(async function () {
        [deployer, member, issuer, secondIssuer] = await ethers.getSigners();
        memberCredential = loadCredentialForAddress(member.address);
        if (memberCredential.issuerAddress !== issuer.address) {
            throw new Error("L'issuer della VC condivisa non coincide con il trusted issuer del test");
        }

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

        // 5. GovernanceSkill
        const Skill = await ethers.getContractFactory("GovernanceSkill");
        skillModule = await Skill.deploy(
            await token.getAddress(),
            await timelock.getAddress(),
            5000n,
            await calculator.getAddress()
        );
        await skillModule.waitForDeployment();

        // 6. Setup moduli
        await token.setTreasury(await treasury.getAddress());
        await skillModule.setTrustedIssuer(issuer.address);

        // 7. Fondatore (deployer) entra e delega
        await token.joinDAO({ value: ethers.parseEther("100") });
        await token.delegate(deployer.address);

        // 8. Governor
        const Governor = await ethers.getContractFactory("MyGovernor");
        governor = await Governor.deploy(
            await token.getAddress(), await skillModule.getAddress(), await timelock.getAddress(),
            VOTING_DELAY, VOTING_PERIOD, 0, 20, 70
        );
        await governor.waitForDeployment();

        const governorAddr = await governor.getAddress();
        await timelock.grantRole(await timelock.PROPOSER_ROLE(),  governorAddr);
        await timelock.grantRole(await timelock.EXECUTOR_ROLE(),  ethers.ZeroAddress);
        await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);

        // 9. Il membro entra con 5 ETH e delega
        await token.connect(member).joinDAO({ value: ethers.parseEther("5") });
        await token.connect(member).delegate(member.address);
        await mine(1);
    });

    // =========================================================================
    //  Helper: carica e presenta una VC reale da shared-credentials
    // =========================================================================
    async function upgradeWithSharedCredential(
        target: HardhatEthersSigner,
        credential: LoadedCredential = loadCredentialForAddress(target.address),
        registerDid: boolean = true,
    ) {
        if (registerDid && await skillModule.memberDID(target.address) === ethers.ZeroHash) {
            await skillModule.connect(target).registerDID(credential.vcData.credentialSubject.id);
        }
        await skillModule.connect(target).upgradeSkillWithVC(credential.vcData, credential.signature);
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
        const skillAddr = await skillModule.getAddress();
        const calldata = skillModule.interface.encodeFunctionData("upgradeSkill", [
            target.address, skills, ethers.keccak256(ethers.toUtf8Bytes(proof)),
        ]);
        const description = `Upgrade ${target.address.slice(0, 8)} skills:${skills.join(",")}`;
        const tx = await governor.proposeWithTopic([skillAddr], [0n], [calldata], description, topicId);
        const receipt = await tx.wait();
        const proposalId = receipt!.logs
            .map((l: any) => { try { return governor.interface.parseLog(l); } catch { return null; } })
            .find((p: any) => p?.name === "ProposalCreated")?.args?.proposalId;

        await mine(VOTING_DELAY + 1);
        await governor.castVote(proposalId, 1);
        await mine(VOTING_PERIOD + 1);

        const descHash = ethers.id(description);
        await governor.queue([skillAddr], [0n], [calldata], descHash);
        await time.increase(TIMELOCK_DELAY + 1);
        await governor.execute([skillAddr], [0n], [calldata], descHash);
    }

    async function addTrustedIssuerThroughTimelock(newIssuer: string) {
        const timelockAddr = await timelock.getAddress();
        await deployer.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });
        await ethers.provider.send("hardhat_impersonateAccount", [timelockAddr]);
        try {
            const timelockSigner = await ethers.getSigner(timelockAddr);
            await skillModule.connect(timelockSigner).setTrustedIssuer(newIssuer);
        } finally {
            await ethers.provider.send("hardhat_stopImpersonatingAccount", [timelockAddr]);
        }
    }

    async function upgradeAsTimelock(names: string[]) {
        const address = await timelock.getAddress();
        await ethers.provider.send("hardhat_setBalance", [address, "0xDE0B6B3A7640000"]);
        await ethers.provider.send("hardhat_impersonateAccount", [address]);
        try {
            return await skillModule.connect(await ethers.getSigner(address)).upgradeSkill(
                member.address, names, ethers.id("bitmap test"),
            );
        } finally {
            await ethers.provider.send("hardhat_stopImpersonatingAccount", [address]);
        }
    }

    async function removeTrustedIssuerThroughTimelock(oldIssuer: string) {
        const timelockAddr = await timelock.getAddress();
        await deployer.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });
        await ethers.provider.send("hardhat_impersonateAccount", [timelockAddr]);
        try {
            const timelockSigner = await ethers.getSigner(timelockAddr);
            return await skillModule.connect(timelockSigner).removeTrustedIssuer(oldIssuer);
        } finally {
            await ethers.provider.send("hardhat_stopImpersonatingAccount", [timelockAddr]);
        }
    }

    // =========================================================================
    //  Test: configurazione contratto
    // =========================================================================
    it("SkillCalculator è correttamente linkato a GovernanceSkill", async function () {
        expect(await skillModule.skillCalculator()).to.equal(await calculator.getAddress());
    });

    it("VPVerifier usa lo stesso domain separator EIP-712 dello script Veramo", async function () {
        expect(await skillModule.UNIVERSAL_DOMAIN_SEPARATOR()).to.equal(
            ethers.TypedDataEncoder.hashDomain(EIP712_DOMAIN),
        );
    });

    it("isValidTopic() riflette i topic del SkillCalculator (0,1,2,3 validi; 4 no)", async function () {
        expect(await skillModule.isValidTopic(0)).to.be.true;
        expect(await skillModule.isValidTopic(1)).to.be.true;
        expect(await skillModule.isValidTopic(2)).to.be.true;
        expect(await skillModule.isValidTopic(3)).to.be.true;
        expect(await skillModule.isValidTopic(4)).to.be.false;
    });

    it("espone soltanto le otto nuove skill case-sensitive", async function () {
        const expectedSkills = [
            "machineLearning",
            "dataEngineering",
            "cyberSecurity",
            "cloudArchitecture",
            "distributedSystems",
            "blockchain",
            "softwareArchitecture",
            "startupFinance",
        ];

        expect(await skillModule.getSupportedSkills()).to.deep.equal(skillIds(expectedSkills));
        for (const skillName of expectedSkills) {
            expect(await skillModule.isValidSkill(skill(skillName))).to.be.true;
        }
        expect(await skillModule.isValidSkill(skill("machine-learning"))).to.be.false;
    });

    it("constructor rifiuta un calculator non-contract", async function () {
        const Skill = await ethers.getContractFactory("GovernanceSkill");
        await expect(
            Skill.deploy(await token.getAddress(), await timelock.getAddress(), 5000n, member.address)
        ).to.be.revertedWithCustomError(skillModule, "NotAContract");
    });

    it("supporta un insieme di trusted issuer", async function () {
        await addTrustedIssuerThroughTimelock(secondIssuer.address);

        expect(await skillModule.trustedIssuers(issuer.address)).to.equal(true);
        expect(await skillModule.trustedIssuers(secondIssuer.address)).to.equal(true);
        expect(await skillModule.trustedIssuerCount()).to.equal(2n);
    });

    it("rimuove un trusted issuer senza usare una lista on-chain", async function () {
        await addTrustedIssuerThroughTimelock(secondIssuer.address);
        await removeTrustedIssuerThroughTimelock(secondIssuer.address);

        expect(await skillModule.trustedIssuers(secondIssuer.address)).to.equal(false);
        expect(await skillModule.trustedIssuerCount()).to.equal(1n);
    });

    it("non permette di rimuovere l'ultimo trusted issuer", async function () {
        await expect(
            removeTrustedIssuerThroughTimelock(issuer.address)
        ).to.be.revertedWithCustomError(skillModule, "CannotRemoveLastTrustedIssuer");
    });

    // =========================================================================
    //  Test: SkillCalculator puro (logica di scoring)
    // =========================================================================
    it("SkillCalculator implementa l'intera matrice di rilevanza skill-topic", async function () {
        const matrix: Array<[string, bigint[]]> = [
            ["machineLearning",      [35n,  5n,  5n, 15n]],
            ["dataEngineering",      [30n, 20n, 15n, 20n]],
            ["cyberSecurity",        [15n, 35n, 25n, 20n]],
            ["cloudArchitecture",    [15n, 30n, 20n, 30n]],
            ["distributedSystems",   [20n, 30n, 25n, 30n]],
            ["blockchain",            [5n, 15n, 35n, 15n]],
            ["softwareArchitecture", [15n, 25n, 20n, 35n]],
            ["startupFinance",       [15n, 10n, 30n, 25n]],
        ];

        for (const [skillName, expectedScores] of matrix) {
            expect(await calculator.calculateAllVP(skillIds([skillName]))).to.deep.equal(expectedScores);
        }
    });

    it("SkillCalculator applica il boost blockchain+startupFinance su FinTech & Blockchain", async function () {
        const scoreCombo = await scoreForTopic(2, ["blockchain", "startupFinance"]);
        expect(scoreCombo).to.equal(75n);
    });

    it("SkillCalculator applica il boost softwareArchitecture+cloudArchitecture su Enterprise Software", async function () {
        const scoreCombo = await scoreForTopic(3, ["softwareArchitecture", "cloudArchitecture"]);
        expect(scoreCombo).to.equal(75n);
    });

    it("SkillCalculator applica +10 alle coppie AI e Cloud senza annullarlo col cap", async function () {
        expect(await scoreForTopic(0, ["machineLearning", "dataEngineering"])).to.equal(75n);
        expect(await scoreForTopic(1, ["cyberSecurity", "cloudArchitecture"])).to.equal(75n);
    });

    it("SkillCalculator riproduce l'esempio AI 35+30+15+10 = 90", async function () {
        expect(
            await scoreForTopic(0, ["machineLearning", "dataEngineering", "cyberSecurity"])
        ).to.equal(90n);
    });

    it("SkillCalculator cappa a 100 un profilo multidisciplinare", async function () {
        expect(
            await scoreForTopic(0, ["machineLearning", "dataEngineering", "cyberSecurity", "distributedSystems"])
        ).to.equal(100n);
    });

    it("SkillCalculator ignora skill duplicate e sconosciute", async function () {
        const scores = await calculator.calculateAllVP(
            skillIds(["machineLearning", "machineLearning", "unknownSkill"])
        );
        expect(scores).to.deep.equal([35n, 5n, 5n, 15n]);
    });

    it("le 256 bitmap rispettano matrice, boost e cap per tutti i topic", async function () {
        const relevance = [
            [35, 5, 5, 15], [30, 20, 15, 20], [15, 35, 25, 20], [15, 30, 20, 30],
            [20, 30, 25, 30], [5, 15, 35, 15], [15, 25, 20, 35], [15, 10, 30, 25],
        ];
        const pairs = [[0, 1], [2, 3], [5, 7], [6, 3]];
        const supported = Array.from(await skillModule.getSupportedSkills());
        for (let bitmap = 0; bitmap < 256; bitmap++) {
            const present = (index: number) => (bitmap & (1 << index)) !== 0;
            const expected = pairs.map(([first, second], topic) => BigInt(Math.min(100,
                relevance.reduce((sum, row, index) => sum + (present(index) ? row[topic] : 0), 0)
                    + (present(first) && present(second) ? 10 : 0),
            )));
            expect(await calculator.calculateAllVPFromBitmap(bitmap)).to.deep.equal(expected);
            expect(await calculator.calculateAllVP(supported.filter((_, i) => present(i)))).to.deep.equal(expected);
        }
        expect(await calculator.calculateAllVPFromBitmap(1n << 255n)).to.deep.equal([0n, 0n, 0n, 0n]);
        expect(await calculator.calculateAllVPFromBitmap((1n << 255n) | 1n)).to.deep.equal([35n, 5n, 5n, 15n]);
    });

    it("bitmap vuota, tutti gli otto bit e getter sono coerenti", async function () {
        expect(await skillModule.memberSkillBitmap(member.address)).to.equal(0n);
        expect(await skillModule.getMemberSkills(member.address)).to.deep.equal([]);
        expect(await skillModule.hasSkill(member.address, skill("machineLearning"))).to.be.false;
        await expect(upgradeAsTimelock([])).not.to.emit(skillModule, "MemberSkillsMerged");

        const names = ["machineLearning", "dataEngineering", "cyberSecurity", "cloudArchitecture",
            "distributedSystems", "blockchain", "softwareArchitecture", "startupFinance"];
        // Inserimento inverso: il getter deve comunque restituire l'ordine canonico.
        for (let i = names.length - 1; i >= 0; i--) {
            await expect(upgradeAsTimelock([names[i], names[i]]))
                .to.emit(skillModule, "MemberSkillsMerged").withArgs(member.address, 1n, BigInt(8 - i));
            expect(await skillModule.memberSkillBitmap(member.address)).to.equal(BigInt(256 - (1 << i)));
            expect(await skillModule.getMemberSkills(member.address)).to.deep.equal(skillIds(names.slice(i)));
            expect(await skillModule.hasSkill(member.address, skill(names[i]))).to.be.true;
        }
        expect(await skillModule.hasSkill(member.address, skill("unknownSkill"))).to.be.false;
        for (let topic = 0; topic < 4; topic++) {
            expect(await skillModule.getSkillVotes(member.address, topic)).to.equal(ethers.parseEther("50"));
        }
    });

    it("merge di skill sovrapposte alla VC preserva i bit e lo snapshot", async function () {
        await upgradeWithSharedCredential(member, memberCredential);
        expect(await skillModule.memberSkillBitmap(member.address)).to.equal(12n);
        const snapshot = await ethers.provider.getBlockNumber();
        const oldVotes = await skillModule.getSkillVotes(member.address, 3);
        const oldTotal = await skillModule.getTotalSkillSupply(3);
        await expect(upgradeAsTimelock(["cloudArchitecture", "softwareArchitecture", "softwareArchitecture"]))
            .to.emit(skillModule, "MemberSkillsMerged").withArgs(member.address, 1n, 3n);
        expect(await skillModule.memberSkillBitmap(member.address)).to.equal(76n);
        expect(await skillModule.getSkillVotes(member.address, 3)).to.equal(ethers.parseEther("47.5"));
        expect(await skillModule.getTotalSkillSupply(3)).to.equal(oldTotal + ethers.parseEther("47.5") - oldVotes);
        expect(await skillModule.getPastSkillVotes(member.address, 3, snapshot)).to.equal(oldVotes);
        expect(await skillModule.getPastTotalSkillSupply(3, snapshot)).to.equal(oldTotal);
    });

    it("una skill sconosciuta annulla l'intero merge senza modificare bitmap o VP", async function () {
        await upgradeWithSharedCredential(member, memberCredential);
        await expect(upgradeAsTimelock(["machineLearning", "unknownSkill"]))
            .to.be.revertedWithCustomError(skillModule, "InvalidSkill").withArgs(skill("unknownSkill"));
        expect(await skillModule.memberSkillBitmap(member.address)).to.equal(12n);
        expect(await skillModule.hasSkill(member.address, skill("machineLearning"))).to.be.false;
        expect(await skillModule.getSkillVotes(member.address, 1)).to.equal(ethers.parseEther("37.5"));
    });

    // =========================================================================
    //  Test: DID binding
    // =========================================================================
    it("registerDID salva un DID unico per il membro", async function () {
        const holderDid = memberCredential.vcData.credentialSubject.id;
        const holderDidHash = ethers.keccak256(ethers.toUtf8Bytes(holderDid));

        await expect(skillModule.connect(member).registerDID(holderDid))
            .to.emit(skillModule, "DIDRegistered")
            .withArgs(member.address, holderDidHash);

        expect(await skillModule.memberDID(member.address)).to.equal(holderDidHash);
        expect(await skillModule.didToAddress(holderDidHash)).to.equal(member.address);
    });

    it("registerDID impedisce di cambiare DID dopo la prima registrazione", async function () {
        const holderDid = memberCredential.vcData.credentialSubject.id;

        await skillModule.connect(member).registerDID(holderDid);
        await expect(
            skillModule.connect(member).registerDID(holderDid)
        ).to.be.revertedWithCustomError(skillModule, "DIDAlreadyRegistered");
    });

    it("registerDID impedisce a un altro membro di registrare lo stesso DID", async function () {
        const holderDid = memberCredential.vcData.credentialSubject.id;

        await skillModule.connect(member).registerDID(holderDid);
        await expect(
            skillModule.connect(deployer).registerDID(holderDid)
        ).to.be.revertedWithCustomError(skillModule, "DIDAlreadyBound");
    });

    // =========================================================================
    //  Test: VC reali condivise e upgradeSkillWithVC
    // =========================================================================
    it("shared-credentials contiene 13 VC EIP-712 coerenti e tutte le skill supportate", async function () {
        const credentials = loadSharedCredentials();
        expect(credentials).to.have.length(13);
        expect(new Set(credentials.map((credential) => credential.holderAddress)).size).to.equal(13);
        expect(new Set(credentials.map((credential) => credential.issuerAddress))).to.deep.equal(new Set([issuer.address]));

        const certifiedSkills = new Set(
            credentials.flatMap((credential) => credential.vcData.credentialSubject.skills),
        );
        expect(certifiedSkills).to.deep.equal(new Set([
            "machineLearning",
            "dataEngineering",
            "cyberSecurity",
            "cloudArchitecture",
            "distributedSystems",
            "blockchain",
            "softwareArchitecture",
            "startupFinance",
        ]));
    });

    it("tutte le VC reali di shared-credentials sono verificabili on-chain", async function () {
        const credentials = loadSharedCredentials();
        const signers = await ethers.getSigners();

        for (const credential of credentials) {
            const holder = signers.find((signer) => signer.address === credential.holderAddress);
            expect(holder, `signer assente per ${credential.fileName}`).not.to.equal(undefined);

            if (!await token.isMember(credential.holderAddress)) {
                await token.connect(holder!).joinDAO({ value: ethers.parseEther("1") });
            }
            await skillModule.connect(holder!).registerDID(credential.vcData.credentialSubject.id);
            await skillModule.connect(holder!).upgradeSkillWithVC(credential.vcData, credential.signature);

            const scores = await calculator.calculateAllVP(
                credential.vcData.credentialSubject.skills.map(skill),
            );
            for (let topicId = 0; topicId < scores.length; topicId++) {
                const expectedVotes = scores[topicId] * 5000n * 10n ** 18n / 10_000n;
                expect(await skillModule.getSkillVotes(credential.holderAddress, topicId)).to.equal(expectedVotes);
            }
        }
    });

    it("upgrade con la VC JSON reale salva le skill certificate", async function () {
        await upgradeWithSharedCredential(member, memberCredential);

        const skills = await skillModule.getMemberSkills(member.address);
        expect(skills).to.deep.equal(memberCredential.vcData.credentialSubject.skills.map(skill));
    });

    it("la coppia cyberSecurity+cloudArchitecture della VC reale produce 37.5 VP sul topic Cloud", async function () {
        await upgradeWithSharedCredential(member, memberCredential);
        expect(await skillModule.getSkillVotes(member.address, 1)).to.equal(ethers.parseEther("37.5"));
    });

    it("ripresentare la stessa VC reale non duplica skill o voting power", async function () {
        await upgradeWithSharedCredential(member, memberCredential);
        const vpBefore = await skillModule.getSkillVotes(member.address, 1);

        const totalBefore = await skillModule.getTotalSkillSupply(1);
        const tx = skillModule.connect(member).upgradeSkillWithVC(memberCredential.vcData, memberCredential.signature);
        await expect(tx).not.to.emit(skillModule, "MemberSkillsMerged");
        await expect(tx).to.emit(skillModule, "SkillUpgraded");
        await expect(tx).to.emit(skillModule, "SkillUpgradedWithVC");

        expect(await skillModule.memberSkillBitmap(member.address)).to.equal(12n);
        expect(await skillModule.getTotalSkillSupply(1)).to.equal(totalBefore);
        expect(await skillModule.getMemberSkills(member.address)).to.have.length(2);
        expect(await skillModule.getSkillVotes(member.address, 1)).to.equal(vpBefore);
    });

    it("rifiuta la VC reale quando il suo firmatario non è più trusted", async function () {
        await addTrustedIssuerThroughTimelock(secondIssuer.address);
        await removeTrustedIssuerThroughTimelock(issuer.address);
        await skillModule.connect(member).registerDID(memberCredential.vcData.credentialSubject.id);

        await expect(
            upgradeWithSharedCredential(member, memberCredential, false)
        ).to.be.revertedWithCustomError(skillModule, "UntrustedIssuer");
    });

    it("rifiuta VC con DID mismatch", async function () {
        await skillModule.connect(member).registerDID("did:example:wrong-holder");
        await expect(
            upgradeWithSharedCredential(member, memberCredential, false)
        ).to.be.revertedWithCustomError(skillModule, "DIDMismatch");
    });

    it("rifiuta una VC reale alterata dopo la firma", async function () {
        await skillModule.connect(member).registerDID(memberCredential.vcData.credentialSubject.id);
        const tamperedVc = {
            ...memberCredential.vcData,
            credentialSubject: {
                ...memberCredential.vcData.credentialSubject,
                unit: "Tampered unit",
            },
        };

        await expect(
            skillModule.connect(member).upgradeSkillWithVC(tamperedVc, memberCredential.signature)
        ).to.be.revertedWithCustomError(skillModule, "UntrustedIssuer");
    });

    it("rifiuta VC se il membro non ha registrato un DID", async function () {
        await expect(
            upgradeWithSharedCredential(member, memberCredential, false)
        ).to.be.revertedWithCustomError(skillModule, "NoDIDRegistered");
    });

    it("constructor rifiuta SkillCalculator zero address", async function () {
        const Timelock2 = await ethers.getContractFactory("TimelockController");
        const tl2 = await Timelock2.deploy(3600, [], [], deployer.address);
        await tl2.waitForDeployment();
        const Token2 = await ethers.getContractFactory("GovernanceToken");
        const token2 = await Token2.deploy(await tl2.getAddress(), 5000n, 5000n);
        await token2.waitForDeployment();

        const Skill2 = await ethers.getContractFactory("GovernanceSkill");
        await expect(
            Skill2.deploy(await token2.getAddress(), await tl2.getAddress(), 5000n, ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(skillModule, "ZeroAddress");
    });

    // =========================================================================
    //  Test: governance legacy upgradeSkill (via proposta)
    // =========================================================================
    it("upgradeSkill via governance: aggiunge skill e aggiorna checkpoint", async function () {
        await doUpgradeViaGovernance(member, ["softwareArchitecture", "blockchain"], "Approvato da governance", 0);

        const skills = await skillModule.getMemberSkills(member.address);
        expect(skills).to.include(skill("softwareArchitecture"));
        expect(skills).to.include(skill("blockchain"));
        expect(await skillModule.getSkillVotes(member.address, 0)).to.equal(ethers.parseEther("10"));
    });

    // =========================================================================
    //  Test: stake + skill VP correnti
    // =========================================================================
    it("stake VP e skill VP restano separati nei moduli corretti", async function () {
        // Stake: 5 ETH → 2.5 COMP
        const stakeVP = await token.balanceOf(member.address);

        await upgradeWithSharedCredential(member, memberCredential);
        const totalVP = stakeVP + await skillModule.getSkillVotes(member.address, 1);
        expect(totalVP).to.equal(stakeVP + ethers.parseEther("37.5"));
    });

    // =========================================================================
    //  Test: getPastSkillVotes (snapshot invarianza)
    // =========================================================================
    it("getPastSkillVotes: ripresentare la VC non altera lo snapshot precedente", async function () {
        await upgradeWithSharedCredential(member, memberCredential);
        const snapshot = await ethers.provider.getBlockNumber();
        await mine(1);

        await upgradeWithSharedCredential(member, memberCredential);

        const pastVP = await skillModule.getPastSkillVotes(member.address, 1, snapshot);
        expect(pastVP).to.equal(ethers.parseEther("37.5"));
    });
});

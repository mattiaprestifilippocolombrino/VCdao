import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

export const DAO_ROOT = path.join(__dirname, "..");
export const DEPLOYED_ADDRESSES_FILE = path.join(DAO_ROOT, "deployedAddresses.json");
export const PROPOSAL_STATE_FILE = path.join(DAO_ROOT, "proposalState.json");

export interface DeployedAddresses {
    token: string;
    skillModule: string;
    calculator: string;
    timelock: string;
    governor: string;
    treasury: string;
    registry: string;
    mockStartup: string;
    mockStartupId: number | string;
    deployer: string;
    issuer: string;
    trustedIssuers: string[];
    weightSkill: number;
    weightStake: number;
}

export interface StoredProposal {
    id: string;
    amount: string;
    topicId: number;
    desc: string;
}

export interface ProposalState {
    proposals: StoredProposal[];
}

export type ContractAddressKey =
    | "token"
    | "skillModule"
    | "calculator"
    | "timelock"
    | "governor"
    | "treasury"
    | "registry"
    | "mockStartup";

function readJsonFile<T>(filePath: string): T {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File non trovato: ${filePath}. Esegui prima lo step precedente della pipeline.`);
    }

    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    } catch (error) {
        throw new Error(`JSON non valido in ${filePath}: ${(error as Error).message}`);
    }
}

function requireAddress(value: unknown, label: string): string {
    if (typeof value !== "string" || !ethers.isAddress(value)) {
        throw new Error(`${label} mancante o non valido in deployedAddresses.json`);
    }
    return ethers.getAddress(value);
}

function optionalAddress(value: unknown, label: string): string {
    if (value === undefined || value === null || value === "") {
        return "";
    }
    return requireAddress(value, label);
}

export function writeJsonFile(filePath: string, value: unknown): void {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadDeployedAddresses(): DeployedAddresses {
    const raw = readJsonFile<Partial<DeployedAddresses>>(DEPLOYED_ADDRESSES_FILE);

    const trustedIssuers = raw.trustedIssuers ?? (raw.issuer ? [raw.issuer] : []);
    if (!Array.isArray(trustedIssuers) || trustedIssuers.length === 0) {
        throw new Error("trustedIssuers/issuer mancante in deployedAddresses.json");
    }

    return {
        token: optionalAddress(raw.token, "token"),
        skillModule: optionalAddress(raw.skillModule, "skillModule"),
        calculator: optionalAddress(raw.calculator, "calculator"),
        timelock: optionalAddress(raw.timelock, "timelock"),
        governor: optionalAddress(raw.governor, "governor"),
        treasury: optionalAddress(raw.treasury, "treasury"),
        registry: optionalAddress(raw.registry, "registry"),
        mockStartup: optionalAddress(raw.mockStartup, "mockStartup"),
        mockStartupId: raw.mockStartupId ?? 0,
        deployer: requireAddress(raw.deployer, "deployer"),
        issuer: requireAddress(raw.issuer, "issuer"),
        trustedIssuers: trustedIssuers.map((issuer, i) => requireAddress(issuer, `trustedIssuers[${i}]`)),
        weightSkill: Number(raw.weightSkill),
        weightStake: Number(raw.weightStake),
    };
}

export function loadProposalState(): ProposalState {
    const state = readJsonFile<Partial<ProposalState>>(PROPOSAL_STATE_FILE);
    if (!Array.isArray(state.proposals) || state.proposals.length === 0) {
        throw new Error("proposalState.json non contiene proposte. Esegui prima scripts/06_createProposals.ts.");
    }

    for (const [i, proposal] of state.proposals.entries()) {
        if (!proposal.id || !proposal.amount || typeof proposal.topicId !== "number" || !proposal.desc) {
            throw new Error(`Proposta ${i} incompleta in proposalState.json`);
        }
    }

    return state as ProposalState;
}

export async function assertContractsDeployed(
    addresses: DeployedAddresses,
    keys: readonly ContractAddressKey[]
): Promise<void> {
    const missing: string[] = [];

    for (const key of keys) {
        if (!ethers.isAddress(addresses[key])) {
            missing.push(`${key}=<mancante>`);
            continue;
        }

        const code = await ethers.provider.getCode(addresses[key]);
        if (code === "0x") {
            missing.push(`${key}=${addresses[key]}`);
        }
    }

    if (missing.length > 0) {
        throw new Error(
            `Contratti non trovati sulla rete '${network.name}': ${missing.join(", ")}.\n` +
            "Per la pipeline multi-step locale avvia `npx hardhat node`, poi esegui ogni script con `--network localhost`."
        );
    }
}

export function assertSufficientSigners(signers: readonly unknown[], required: number): void {
    if (signers.length < required) {
        throw new Error(`Servono almeno ${required} signer Hardhat, disponibili: ${signers.length}`);
    }
}

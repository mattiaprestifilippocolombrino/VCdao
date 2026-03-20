import { agent } from "./agent/setup";
import * as fs from "fs";
async function run() {
  const vc = JSON.parse(fs.readFileSync("./credentials/student-luca-bianchi.json", "utf-8"));
  const vp = await agent.createVerifiablePresentation({
    presentation: {
      holder: vc.credentialSubject.id,
      verifiableCredential: [vc]
    },
    proofFormat: "EthereumEip712Signature2021"
  });
  console.log(JSON.stringify(vp, null, 2));
}
run().catch(console.error);

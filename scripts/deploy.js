import { PinataSDK } from "pinata";
import fs from "fs";
import path from "path";

const pinata = new PinataSDK({
  pinataJwt: process.env.PINATA_JWT,
  pinataGateway: "gateway.pinata.cloud",
});

async function deploy() {
  try {
    const distPath = path.resolve("./dist");
    console.log(`Uploading ${distPath} to Pinata...`);

    const upload = await pinata.upload.directory(distPath).addMetadata({
        name: "ipfs-universe"
    });

    console.log("Upload successful!");
    console.log(`CID: ${upload.IpfsHash}`);
    
    // Output for GitHub Actions
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `cid=${upload.IpfsHash}\n`);
    }
  } catch (error) {
    console.error("Upload failed:", error);
    process.exit(1);
  }
}

deploy();

import pinataSDK from '@pinata/sdk';
import fs from 'fs';
import path from 'path';

// Note: @pinata/sdk is a CommonJS module, so we might need to handle the default export
const PinataClient = pinataSDK.default || pinataSDK;
const pinata = new PinataClient({ pinataJWTKey: process.env.PINATA_JWT });

async function deploy() {
  try {
    const distPath = path.resolve("./dist");
    console.log(`Uploading ${distPath} to Pinata...`);

    const result = await pinata.pinFromFS(distPath, {
      pinataMetadata: {
        name: 'ipfs-universe'
      }
    });

    console.log("Upload successful!");
    console.log(`CID: ${result.IpfsHash}`);
    
    // Output for GitHub Actions
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `cid=${result.IpfsHash}\n`);
    }
  } catch (error) {
    console.error("Upload failed:", error);
    process.exit(1);
  }
}

deploy();

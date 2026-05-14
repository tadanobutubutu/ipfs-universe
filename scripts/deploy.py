import os
import requests
import sys
from pathlib import Path

def deploy():
    jwt = os.environ.get('PINATA_JWT')
    if not jwt:
        print("Error: PINATA_JWT not set")
        sys.exit(1)

    dist_dir = Path('./dist')
    url = "https://api.pinata.cloud/pinning/pinFileToIPFS"
    headers = {
        'Authorization': f'Bearer {jwt}'
    }

    files = []
    # Add metadata for the pin name
    files.append(('pinataMetadata', (None, '{"name": "ipfs-universe"}')))
    
    # Add files
    for file_path in dist_dir.rglob('*'):
        if file_path.is_file():
            # Pinata expects the relative path in the filename field for directory uploads
            rel_path = file_path.relative_to(dist_dir.parent)
            files.append(('file', (str(rel_path), open(file_path, 'rb'))))

    print(f"Uploading {len(files)-1} files to Pinata...")
    response = requests.post(url, headers=headers, files=files)
    
    if response.status_code != 200:
        print(f"Error: {response.status_code}")
        print(response.text)
        sys.exit(1)

    data = response.json()
    cid = data.get('IpfsHash')
    if not cid:
        print("Error: No IpfsHash in response")
        print(data)
        sys.exit(1)

    print(f"Successfully uploaded. CID: {cid}")
    
    # Output for GitHub Actions
    github_output = os.environ.get('GITHUB_OUTPUT')
    if github_output:
        with open(github_output, 'a') as f:
            f.write(f"cid={cid}\n")

if __name__ == "__main__":
    deploy()

import os
import requests
import sys
from pathlib import Path

import os
import requests
import sys
from pathlib import Path

def create_github_deployment():
    token = os.environ.get('GITHUB_TOKEN')
    repo = os.environ.get('GITHUB_REPOSITORY')
    ref = os.environ.get('GITHUB_SHA')
    if not token or not repo:
        return None

    url = f"https://api.github.com/repos/{repo}/deployments"
    headers = {
        'Authorization': f'token {token}',
        'Accept': 'application/vnd.github.v3+json'
    }
    payload = {
        'ref': ref,
        'environment': 'production',
        'description': 'Deploy to IPFS via Pinata',
        'required_contexts': [],
        'auto_merge': False
    }
    res = requests.post(url, headers=headers, json=payload)
    if res.status_code == 201:
        return res.json().get('id')
    return None

def update_github_deployment_status(deployment_id, state, environment_url=None):
    token = os.environ.get('GITHUB_TOKEN')
    repo = os.environ.get('GITHUB_REPOSITORY')
    if not token or not repo or not deployment_id:
        return

    url = f"https://api.github.com/repos/{repo}/deployments/{deployment_id}/statuses"
    headers = {
        'Authorization': f'token {token}',
        'Accept': 'application/vnd.github.v3+json'
    }
    payload = {
        'state': state,
        'log_url': f"https://github.com/{repo}/actions/runs/{os.environ.get('GITHUB_RUN_ID')}",
        'environment_url': environment_url or 'https://ipfsuniverse.xyz/'
    }
    requests.post(url, headers=headers, json=payload)

def deploy():
    deployment_id = create_github_deployment()
    if deployment_id:
        update_github_deployment_status(deployment_id, 'in_progress')

    jwt = os.environ.get('PINATA_JWT')
    if not jwt:
        print("Error: PINATA_JWT not set")
        if deployment_id: update_github_deployment_status(deployment_id, 'failure')
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
    try:
        response = requests.post(url, headers=headers, files=files)
        
        if response.status_code != 200:
            print(f"Error: {response.status_code}")
            print(response.text)
            if deployment_id: update_github_deployment_status(deployment_id, 'failure')
            sys.exit(1)

        data = response.json()
        cid = data.get('IpfsHash')
        if not cid:
            print("Error: No IpfsHash in response")
            print(data)
            if deployment_id: update_github_deployment_status(deployment_id, 'failure')
            sys.exit(1)

        print(f"Successfully uploaded. CID: {cid}")
        
        if deployment_id:
            update_github_deployment_status(deployment_id, 'success', 'https://ipfsuniverse.xyz/')

        # Output for GitHub Actions
        github_output = os.environ.get('GITHUB_OUTPUT')
        if github_output:
            with open(github_output, 'a') as f:
                f.write(f"cid={cid}\n")
    except Exception as e:
        print(f"Deployment exception: {e}")
        if deployment_id: update_github_deployment_status(deployment_id, 'failure')
        sys.exit(1)

if __name__ == "__main__":
    deploy()

if __name__ == "__main__":
    deploy()

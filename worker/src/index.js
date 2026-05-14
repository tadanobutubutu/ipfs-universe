export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const domain = url.hostname.replace(/^www\./, '');

    // Fetch the DNSLink TXT record for the domain using Cloudflare DNS over HTTPS
    const dnsUrl = `https://cloudflare-dns.com/dns-query?name=_dnslink.${domain}&type=TXT`;
    
    try {
      const dnsRes = await fetch(dnsUrl, {
        headers: { "Accept": "application/dns-json" }
      });
      const dnsData = await dnsRes.json();
      
      let cid = null;
      if (dnsData.Status === 0 && dnsData.Answer) {
        for (const record of dnsData.Answer) {
          // Record data format: "dnslink=/ipfs/Qm..."
          const match = record.data.match(/dnslink=\/ipfs\/([a-zA-Z0-9]+)/);
          if (match && match[1]) {
            cid = match[1];
            break;
          }
        }
      }

      if (!cid) {
        return new Response("No DNSLink found for " + domain + ". DNS data: " + JSON.stringify(dnsData), { status: 404 });
      }

      // Pinata Gateway is very fast, but let's have fallbacks
      const gateways = [
        "https://gateway.pinata.cloud/ipfs/",
        "https://dweb.link/ipfs/",
        "https://ipfs.io/ipfs/"
      ];

      for (const gateway of gateways) {
        try {
          // Request from IPFS gateway
          const targetUrl = `${gateway}${cid}${url.pathname}${url.search}`;
          const response = await fetch(targetUrl, {
            headers: {
              "User-Agent": request.headers.get("User-Agent") || "CloudflareWorker/1.0"
            },
            // Follow redirects if any
            redirect: "follow"
          });
          
          if (response.ok) {
            // Return the response to the user
            const proxyRes = new Response(response.body, response);
            proxyRes.headers.set("X-IPFS-CID", cid);
            proxyRes.headers.set("X-IPFS-Gateway", gateway);
            // Ensure proper content-type for HTML if missing
            if (url.pathname === '/' || url.pathname.endsWith('.html')) {
              proxyRes.headers.set("Content-Type", "text/html; charset=utf-8");
            }
            return proxyRes;
          }
        } catch (e) {
          // Ignore fetch errors and try next gateway
          continue;
        }
      }
      
      return new Response(`Failed to fetch from IPFS gateways. CID: ${cid}`, { status: 502 });

    } catch (e) {
      return new Response("Internal Server Error: " + e.message, { status: 500 });
    }
  }
};

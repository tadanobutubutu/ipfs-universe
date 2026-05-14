const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

async function getPage(pageId) {
  try {
    const response = await notion.pages.retrieve({ page_id: pageId });
    console.log(JSON.stringify(response, null, 2));
    
    const blocks = await notion.blocks.children.list({ block_id: pageId });
    console.log("\n--- Blocks ---");
    console.log(JSON.stringify(blocks, null, 2));
  } catch (error) {
    console.error(error.body);
  }
}

const pageId = process.argv[2];
if (pageId) {
  getPage(pageId);
} else {
  console.log("Please provide a page ID");
}

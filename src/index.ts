import { ConfigHandler } from "./config-handler.ts";
import { DocumentDb } from "./document-db.ts";
import { QueryServer } from "./query-server.ts";

async function main() {
  //load the config file
  const config = new ConfigHandler().config
  //set the API key for the OpenAI API
  process.env["OPENAI_API_KEY"] = config.openAiKey

  //load or build up vector db
  const db = new DocumentDb(config);
  await db.loadOrBuildUp();
  //when files get added or changed, update vector db
  db.startCyclicUpdater(60000)

  //start the server that waits for requests from the GOLDEN ChatGPT Plugin
  new QueryServer(db).run();
}

main()
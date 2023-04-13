const fs = require("fs");
const path = require("path");
const socketIOClient = require("socket.io-client");
const { glob } = require("glob");
const { CharacterTextSplitter } = require("langchain/text_splitter");
const { HNSWLib } = require("langchain/vectorstores/hnswlib");
const { OpenAIEmbeddings } = require("langchain/embeddings/openai");
const { DocxLoader } = require("langchain/document_loaders/fs/docx");
const { PDFLoader } = require("langchain/document_loaders/fs/pdf");
const { OpenAI } = require("langchain/llms/openai");
const { VectorDBQAChain } = require("langchain/chains");


async function main() {

  console.log("Starting local GOLDEN data source")

  //load the config file
  const config = new ConfigHandler().config;
  //set the API key for the OpenAI API
  process.env["OPENAI_API_KEY"] = config.openAiKey;

  //load or build up vector db
  const db = new DocumentDb(config);
  await db.loadOrBuildUp();
  //when files get added or changed, update vector db
  db.startCyclicUpdater(60000);

  //start the server that waits for requests from the GOLDEN ChatGPT Plugin
  new QueryServer(db).run();
}

class ConfigHandler {
  private readonly configFilePath: string = "config.json";
  config: Config;

  constructor() {
    this.loadConfig();
  }

  private loadConfig(): void {
    const rawData = fs.readFileSync(this.configFilePath);
    this.config = JSON.parse(rawData.toString());
  }

  public getFilePatterns(): string[] {
    return this.config.filePatterns;
  }
}

class QueryServer {
  constructor(private db: DocumentDb) {}

  async run() {
    const chain = VectorDBQAChain.fromLLM(new OpenAI(), this.db.store);

    // Create a Socket.IO server
    const socket = socketIOClient("https://goldenretriever.herokuapp.com");

    console.log("Ready, waiting for request from ChatGPT");

    socket.on("connect", () => {
      console.log("Connected to GOLDEN, internal connection id:", socket.id);

      socket.on("disconnect", () => {
        console.log("Disconnected from GOLDEN:", socket.id);
      });

      socket.on("process_question", async (data: { text: string }) => {
        console.log("Processing question:", data.text);
        const question = data.text;
        const result: any = await this.db.lock.runWithLock(() => {
          return chain.call({ query: question });
        });
        const answer = result.text;
        const sources = result?.sources;
        const response = [{ answer: answer, source: sources }];
        console.log("Sending result", response);
        socket.emit("queryResult", response);
      });
    });
  }
}

class Config {
  filePatterns: string[];
  openAiKey: string;
}

class DocumentDb {
  store: typeof HNSWLib;
  lock = new AsyncLock();
  private dbDirectory = "DocumentDb";

  constructor(private config: Config) {}

  async loadOrBuildUp(): Promise<void> {
    if (this.isExistingOnDisk) {
      await this.load();
      await this.update();
    } else {
      await this.buildUpFromScratch();
      await this.save();
    }
  }

  async load(): Promise<void> {
    if (!this.isExistingOnDisk) {
      throw new Error(
        "Document DB not existing yet, please create first using buildUpFromScratch()"
      );
    }
    this.store = await HNSWLib.load(this.dbDirectory, new OpenAIEmbeddings());
  }

  async save(): Promise<void> {
    if (this.store == null) {
      throw new Error(
        "Document DB not existing yet, please load (using load()) or create first (using buildUpFromScratch())"
      );
    }
    this.store.save(this.dbDirectory);
  }

  get isExistingOnDisk() {
    return fs.existsSync(`${this.dbDirectory}\\hnswlib.index`);
  }

  async buildUpFromScratch(): Promise<void> {
    console.log(
      "Indexing your documents (this can take some minutes - please don't close app during indexing)"
    );

    // Load in the data in the format that Notion exports it in
    const paths = this.getFilePaths();

    const data: string[] = [];
    const sources: string[] = [];
    const lastChangedDates: Date[] = [];

    for (const p of paths) {
      try {
        const filePath = path.join("./", p);
        const fileContent = await this.loadFileContent(filePath);
        const fileStat = fs.statSync(filePath);
        data.push(fileContent);
        sources.push(filePath);
        lastChangedDates.push(fileStat.mtime);
      } catch (e) {
        console.log("File could not be loaded: ", e);
      }
    }

    // Split the documents, as needed, into smaller chunks
    // We do this due to the context limits of the LLMs
    const textSplitter = new CharacterTextSplitter({
      separator: "\n",
      chunkSize: 1500,
    });
    const docs: string[] = [];
    const metadatas: { source: string; lastChanged: Date }[] = [];

    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const splits = await textSplitter.splitText(d);
      docs.push(...splits);
      metadatas.push(
        ...Array(splits.length).fill({
          source: sources[i],
          lastChanged: lastChangedDates[i],
        })
      );
    }

    // Create a vector store from the documents and save it to disk
    const s = await HNSWLib.fromTexts(docs, metadatas, new OpenAIEmbeddings());
    this.store = s;

    console.log("Index build up done");
  }

  private async loadFileContent(filePath: string): Promise<string> {
    const ext = path.extname(filePath)?.toUpperCase();
    let fileContent: string;
    if (ext == ".DOCX") {
      return (await new DocxLoader(filePath).load())[0].pageContent;
    } else if (ext == ".PDF") {
      return (await new PDFLoader(filePath).load())[0].pageContent;
    }
    fileContent = fs.readFileSync(filePath, { encoding: "utf-8" });
    return fileContent;
  }

  async update(): Promise<void> {
    if (this.store == null) {
      throw new Error("Please first buildUp or load");
    }

    console.log(
      "Updating your documents (this can take some minutes - please don't close app during update)"
    );

    // Scan the files again
    const paths = this.getFilePaths();

    const textSplitter = new CharacterTextSplitter({
      separator: "\n",
      chunkSize: 1500,
    });

    const existingDocs = [...this.store.docstore._docs.values()];
    const newDocs: any[] = [];
    for (const p of paths) {
      const filePath = path.join("./", p);
      const fileStat = fs.statSync(filePath);
      const lastChangedDate = fileStat.mtime;

      // Check if the file is new or has been modified since the last update

      const existingDoc = existingDocs.find(
        (x) => x.metadata.source == filePath
      );
      const shouldUpdate =
        !existingDoc ||
        (existingDoc && existingDoc.metadata.lastChanged < lastChangedDate);

      if (shouldUpdate) {
        const fileContent = await this.loadFileContent(filePath);
        const splits = await textSplitter.splitText(fileContent);

        // Add or update the documents in the store
        for (const split of splits) {
          const newDoc = {
            pageContent: split,
            metadata: { source: filePath, lastChanged: lastChangedDate },
          };
          newDocs.push(newDoc);
        }
      }
    }

    if (newDocs.length == 0) {
      return;
    }
    await this.lock.runWithLock(async () => {
      await this.store.addDocuments(newDocs);
      await this.save();
      return null;
    });

    console.log("Updating done");
  }

  private getFilePaths() {
    return glob.sync(this.config.filePatterns);
  }

  async startCyclicUpdater(msUpdateCycle: number) {
    setInterval(() => {
      this.update();
    }, msUpdateCycle);
  }
}

class AsyncLock {
  private _locked: boolean;
  private _waitQueue: (() => void)[];

  constructor() {
    this._locked = false;
    this._waitQueue = [];
  }

  async acquire(): Promise<void> {
    if (this._locked) {
      await new Promise<void>((resolve) => this._waitQueue.push(resolve));
    }
    this._locked = true;
  }

  release(): void {
    if (this._waitQueue.length > 0) {
      const nextResolve = this._waitQueue.shift();
      if (nextResolve) {
        nextResolve();
      }
    } else {
      this._locked = false;
    }
  }

  async runWithLock<T>(f: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await f();
    } finally {
      this.release();
    }
  }
}

main();

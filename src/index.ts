const fs = require("fs");
const path = require("path");
const socketIOClient = require("socket.io-client");
/*
const { glob } = require("glob");
const ImapClient = require("imap");
const { simpleParser } = require("mailparser");*/
//const moment = require("moment");
const { CharacterTextSplitter } = require("langchain/text_splitter");
const { HNSWLib } = require("langchain/vectorstores/hnswlib");
const { OpenAIEmbeddings } = require("langchain/embeddings/openai");
const { PDFLoader } = require("langchain/document_loaders/fs/pdf");
const { OpenAI } = require("langchain/llms/openai");
const { VectorDBQAChain } = require("langchain/chains");
const JSZip = require('jszip');
const { parseStringPromise } = require('xml2js');


async function main() {

  console.log("Starting local GOLDEN data source");

  //load the config file
  const config = new ConfigHandler().config;
  //set the API key for the OpenAI API
  process.env["OPENAI_API_KEY"] = config.openAiKey;

  //load or build up vector db
  const db = new DocumentDb(config);
  await db.loadOrBuildUp();
  //when files get added or changed, update vector db
  db.startCyclicUpdater(60000);

  // Load or build up vector db for emails
  //const emailDb = new EmailDb(config);
  //await emailDb.loadOrBuildUp();
  //when emails get added, update vector db
  //emailDb.startCyclicUpdater(60000);

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
}

class QueryServer {
  constructor(private db: DocumentDb) {}

  async run() {
    const dbChain = VectorDBQAChain.fromLLM(new OpenAI(), this.db.store);
    //const emailChain = VectorDBQAChain.fromLLM(new OpenAI(), this.email.store);

    // Create a Socket.IO server
    const socket = socketIOClient("https://goldenretriever.herokuapp.com");

    console.log("Ready, connecting with GOLDEN");

    socket.on("connect", () => {
      console.log("Connected to GOLDEN, internal connection id:", socket.id);

      console.log("Ready, waiting for request from ChatGPT");

      socket.on("disconnect", () => {
        console.log("Disconnected from GOLDEN:", socket.id);
      });

      socket.on("process_question", async (data: { text: string }) => {
        console.log("Processing question:", data.text);
        const question = data.text;
        const documentResult: any = await this.db.lock.runWithLock(() => {
          return dbChain.call({ query: question });
        });
        /*
        const emailResult: any = await this.email.lock.runWithLock(() => {
          return emailChain.call({ query: question });
        });        */

        const answer = documentResult.text;
        const sources = documentResult?.sources;
        const response = [{ answer: answer, source: sources }];
        console.log("Sending result");
        socket.emit("queryResult", response);
      });
    });
  }
}

class Config {
  openAiKey: string;
  documents: {
    inUse: boolean;
    filePath: string;
    extensions: string[];
  };
  email: {
    inUse: boolean;
    host: string;
    port: number;
    user: string;
    password: string;
    cutoffDate: string; // ISO formatted date string, e.g., "2021-01-01"
    senderWhitelist: string[]; // Optional list of allowed sender email addresses
  };
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

    // Load in the data
    const paths = await this.getFilePaths();
    const data: string[] = [];
    const sources: string[] = [];
    const lastChangedDates: Date[] = [];
    console.log(`found ${paths.length} files`);
    for (const p of paths) {
      console.log(`  reading file ${p}`);
      try {
        const filePath = path.join("./", p);
        const fileContent = await this.extractFileContent(filePath);
        const fileStat = fs.statSync(filePath);
        data.push(fileContent);
        sources.push(filePath);
        lastChangedDates.push(fileStat.mtime);
      } catch (e) {
        console.log("  File could not be loaded: ", e);
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
    let s = null;
    try {
      s = await HNSWLib.fromTexts(docs, metadatas, new OpenAIEmbeddings());
    } catch (e) {
      console.log("error while building up vector db");
      console.log(e);
    }
    this.store = s;

    //save to disk
    await this.save();

    console.log("Index build up done");
  }

  async update(): Promise<void> {
    if (this.store == null) {
      throw new Error("Please first buildUp or load");
    }

    console.log(
      "Updating your documents (this can take some minutes - please don't close app during update)"
    );

    // Scan the files again
    const paths = await this.getFilePaths();
    const textSplitter = new CharacterTextSplitter({
      separator: "\n",
      chunkSize: 1500,
    });
    const existingDocs = [...this.store.docstore._docs.values()];
    const newDocs: any[] = [];
    for (const p of paths) {
      try {
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
          const fileContent = await this.extractFileContent(filePath);
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
      } catch (e) {
        console.log("  File could not be loaded: ", e);
      }
    }

    if (newDocs.length == 0) {
      return;
    }
    //add to the vector store and save
    await this.lock.runWithLock(async () => {
      await this.store.addDocuments(newDocs);
      await this.save();
      return null;
    });

    console.log("Updating done");
  }

  private async getFilePaths(): Promise<string[]> {
    const allFiles: string[] = [];

    for (const ext of this.config.documents.extensions) {
      console.log(`Searching file path ${this.config.documents.filePath} for ${ext} files`);      
      const files = await this.getFilesWithExtension(this.config.documents.filePath, ext);
      allFiles.push(...files);
    }

    console.log(`files found: ${allFiles.length}`);
    return allFiles;
  }

  async getFilesWithExtension(dirPath: string, ext: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      fs.readdir(dirPath, (err: any, files: any) => {
        if (err) {
          return reject(err);
        }

        const matchingFiles = files.filter(
          (file: any) => path.extname(file).toUpperCase() === ext.toUpperCase()
        );
        const fullPaths = matchingFiles.map((file: any) =>
          path.join(dirPath, file)
        );
        resolve(fullPaths);
      });
    });
  }

  async startCyclicUpdater(msUpdateCycle: number) {
    setInterval(() => {
      this.update();
    }, msUpdateCycle);
  }

  private async extractFileContent(filePath: string): Promise<string> {
    const ext = path.extname(filePath)?.toUpperCase();
    let fileContent: string;
    if (ext == ".DOCX") {
      return await this.extractTextFromDocx(filePath)
    } else if (ext == ".PDF") {
      return (await new PDFLoader(filePath).load())[0].pageContent;
    }
    fileContent = fs.readFileSync(filePath, { encoding: "utf-8" });
    return fileContent;
  }

  
  private async extractTextFromDocx(file: string): Promise<string> {
    const data = fs.readFileSync(file);
    const zip = new JSZip();
    const content = await zip.loadAsync(data);
    const xml = await content.file('word/document.xml')?.async('text');
  
    if (!xml) {
      throw new Error('Failed to read document.xml from the DOCX file.');
    }
  
    const parsedXml = await parseStringPromise(xml);
    const paragraphs = parsedXml['w:document']['w:body'][0]['w:p'];
  
    const textArray: string[] = [];
  
    paragraphs.forEach((paragraph: any) => {
      const runs = paragraph['w:r'];
      runs?.forEach((run: any) => {
        const textElement = run['w:t'];
        if (textElement) {
          textArray.push(textElement[0]['_']);
        }
      });
    });
  
    return textArray.filter(t => t != null).join('\n');
  }
  
  
}

class AsyncLock {
  private locked: boolean;
  private waitQueue: (() => void)[];

  constructor() {
    this.locked = false;
    this.waitQueue = [];
  }

  async acquire(): Promise<void> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.waitQueue.push(resolve));
    }
    this.locked = true;
  }

  release(): void {
    if (this.waitQueue.length > 0) {
      const nextResolve = this.waitQueue.shift();
      if (nextResolve) {
        nextResolve();
      }
    } else {
      this.locked = false;
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

main(); //<- this is where it starts, scroll to the top

/*
class EmailDb {
  store: typeof HNSWLib;
  lock = new AsyncLock();
  private emailDirectory = "EmailDb";

  constructor(private config: Config) {}

  async loadOrBuildUp(): Promise<void> {
    if (this.isExistingOnDisk) {
      await this.load();
      await this.update();
    } else {
      await this.buildUpFromScratch();
    }
  }

  async load(): Promise<void> {
    if (!this.isExistingOnDisk) {
      throw new Error(
        "Email DB not existing yet, please create first using buildUpFromScratch()"
      );
    }
    this.store = await HNSWLib.load(
      this.emailDirectory,
      new OpenAIEmbeddings()
    );
  }

  async save(): Promise<void> {
    if (this.store == null) {
      throw new Error(
        "Email DB not existing yet, please load (using load()) or create first (using buildUpFromScratch())"
      );
    }
    this.store.save(this.emailDirectory);
  }

  get isExistingOnDisk() {
    return fs.existsSync(`${this.emailDirectory}\\hnswlib.index`);
  }

  async buildUpFromScratch(): Promise<void> {
    console.log(
      "Indexing your emails (this can take some minutes - please don't close app during indexing)"
    );

    const emails = await this.fetchEmails();
    const docs = emails.map((email) => email.text);
    const metadatas = emails.map((email) => ({
      source: `Email: ${email.subject}`,
      lastChanged: email.date,
    }));

    this.store = await HNSWLib.fromTexts(
      docs,
      metadatas,
      new OpenAIEmbeddings()
    );

    await this.save();

    console.log("Email index build up done");
  }

  async update(): Promise<void> {
    if (this.store == null) {
      throw new Error("Please first buildUp or load");
    }

    console.log(
      "Updating your emails (this can take some minutes - please don't close app during update)"
    );

    const emails = await this.fetchEmails();
    const newDocs = emails.map((email) => ({
      pageContent: email.text,
      metadata: { source: `Email: ${email.subject}`, lastChanged: email.date },
    }));

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

  async startCyclicUpdater(msUpdateCycle: number) {
    setInterval(() => {
      this.update();
    }, msUpdateCycle);
  }

  async fetchEmails(): Promise<any[]> {
    const emailSettings= this.config.email;
    const client = new ImapClient(emailSettings);
    const emails: any[] = [];

    const connectAndOpenInbox = async () => {
      return new Promise((resolve, reject) => {
        client.once("ready", () => {
          client.openBox("INBOX", false, (err: any, mailbox: any) => {
            if (err) {
              reject(err);
            } else {
              resolve(mailbox);
            }
          });
        });

        client.once("error", (err: any) => {
          reject(err);
        });

        client.connect();
      });
    };

    const searchAndFetchEmails = async () => {
      const searchCriteria = ["UNSEEN"];
      const fetchOptions = {
        bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)", "TEXT"],
        struct: true,
      };

      if (emailSettings.cutoffDate) {
        const formattedCutoffDate = moment(emailSettings.cutoffDate).format("YYYY-MM-DD");
        searchCriteria.push(["SINCE", formattedCutoffDate]);
      }

      if (emailSettings.senderWhitelist && emailSettings.senderWhitelist.length > 0) {
        searchCriteria.push(["FROM", emailSettings.senderWhitelist]);
      }

      return new Promise((resolve, reject) => {
        client.search(searchCriteria, (err:any, results:any) => {
          if (err) {
            reject(err);
            return;
          }

          if (results.length === 0) {
            resolve([]);
            return;
          }

          const f = client.fetch(results, fetchOptions);

          f.on("message", (msg:any) => {
            let email = { subject: "", from: "", to: "", date: "", text: "" };

            msg.on("body", async (stream:any, info:any) => {
              const parser = simpleParser(stream);
              const parsed = await parser;

              email.subject = parsed.subject;
              email.from = parsed.from.value
                .map((addr:any) => addr.address)
                .join(", ");
              email.to = parsed.to.value.map((addr:any) => addr.address).join(", ");
              email.date = parsed.date;
              email.text = parsed.text;

              emails.push(email);
            });
          });

          f.once("error", (err:any) => {
            reject(err);
          });

          f.once("end", () => {
            resolve(emails);
          });
        });
      });
    };

    await connectAndOpenInbox();
    const fetchedEmails = await searchAndFetchEmails();
    client.end();

    return fetchedEmails;
  }
}
*/

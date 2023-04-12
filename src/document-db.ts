import fs from "fs";
import path from "path";
import { glob } from "glob";
import { CharacterTextSplitter } from "langchain/text_splitter";
import { HNSWLib } from "langchain/vectorstores/hnswlib";
import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { Lock } from "./lock.ts";
import { Config } from "./config.ts";
import { DocxLoader, PDFLoader } from "langchain/document_loaders";

export class DocumentDb {
  store: HNSWLib;
  lock = new Lock();
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

import { OpenAI } from "langchain/llms/openai";
import { io as socketIOClient } from "socket.io-client";
import { VectorDBQAChain } from "langchain/chains";
import { DocumentDb } from "./document-db";

export class QueryServer {
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
        const result = await this.db.lock.runWithLock(() => {
          return chain.call({ query: question })
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
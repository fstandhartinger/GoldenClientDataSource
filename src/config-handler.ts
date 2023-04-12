import { Config } from './config.ts';
import * as fs from 'fs';

export class ConfigHandler {
  private readonly configFilePath: string = 'config.json';
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



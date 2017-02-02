export * from './message';
export * from './interfaces';

import * as OS from 'os';
import * as U from './util';
import * as Address from './address';
import { Message } from './message';
import { IClientOptions, IHeaders } from './interfaces';
import * as SMTP from './smtp';

export class MailClient {
  private _opts: IClientOptions;

  public get opts() {
    return this._opts;
  }

  public constructor(opts: IClientOptions) {
    this._opts = opts || {};
    this._opts.domain = this._opts.domain || OS.hostname();
  }

  public async send(message: Message): Promise<void> {
    let client = SMTP.createClient(this._opts);

    return new Promise<void>((res, rej) => {
      client.on('error', function(err) {
        client.end();
        rej(err);
      });
      client.mail(message.sender, message.recipients)
      .on('ready', function () {
        this.on('end', function () {
          client.quit();
          res();
        }).end(message.toString());
      });
    });
  }
}
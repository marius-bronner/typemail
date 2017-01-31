import * as Util from './util';
import * as Address from './address';
import { IHeaders, IAddress } from './interfaces';

export class Message {

    public static readonly HEADERS: string[] = ['Date', 'Sender', 'From', 'To', 'Cc', 'Subject'];

    private _headers: IHeaders = {};
    private _recipients = [];
    private _sender = null;
    private _body: string = '';

    // headers

    public get headers(): IHeaders {
        return this._headers;
    }

    // recipients

    public get recipients(): IAddress[] {
        this.update();
        return this._recipients;
    }

    // sender

    public get sender(): IAddress {
        this.update();
        return this._sender;
    }

    // body

    public get body(): string {
        return this._body;
    }

    public set body(body: string) {
        this._body = body || '';
    }

    public Body(body: string) {
        this.body = body;
        return this;
    }

    public constructor(headers: IHeaders) {
        if (headers) {
            for (let key in headers)
                this._headers[Util.titleCaseHeader(key)] = headers[key];
        }

        if (!('Date' in this._headers)) {
            this._headers['Date'] = Util.date(undefined);
        }
    }

    private update(): void {
        let list = Address.readAddressList(this._headers['Sender'] || this._headers['From']);
        this._sender = (list.length > 0) ? list[0] : null;

        let seen = {}, header;

        ['To', 'Cc', 'Bcc'].forEach((name) => {
            Address.readAddressList(this._headers[name]).forEach((mailbox) => {
                if (!(mailbox in seen)) {
                    seen[mailbox] = true;
                    this._recipients.push(mailbox);
                }
            });
        });
    }

    private formatHeader(name, value) {
        return Util.foldHeader(name, Address.formatAddressList(value), undefined);
    }

    public toString(): string {
        this.update();
        let headers = Util.extend({}, this.headers), result = [], value;

        // Put these headers in a particular order.
        Message.HEADERS.forEach((name) => {
            if (name in headers) {
                result.push(this.formatHeader(name, headers[name]));
                delete headers[name];
            }
        });

        // Hide Bcc recipients.
        if ('Bcc' in headers)
            delete headers['Bcc'];

        // Add the rest of the headers in no particular order.
        for (let key in headers)
            result.push(this.formatHeader(key, headers[key]));

        // The body is separated from the headers by an empty line.
        result.push('');
        result.push(Util.fill(this._body));

        return result.join('\r\n');
    }


}
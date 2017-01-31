import * as Util from 'util';
import * as OS from 'os';
import * as Net from 'net';
import * as Events from 'events';
import * as U from './util';


// ## Client ##

// An SMTP client connects to a server and maintains connection state.

export function createClient(opt) {
  return new Client(opt);
}

Util.inherits(Client, Events.EventEmitter);
export function Client(opt) {
  Events.EventEmitter.call(this);

  this.options = opt;

  if (!(this.host = (opt && opt.host)))
    throw new Error('missing required host');

  if (opt.secure || opt.username) {
    this.useTLS = true;
    if (typeof opt.secure == 'object')
      this.credentials = opt.secure;
  }

  this.port = opt.port || (this.useTLS ? 587 : 25);
  this._domain = opt.domain;
  if (opt.username)
    this.setLogin(opt.username, opt.password);

  this.useSocket(new Net.Socket());
}

// Send a message.
Client.prototype.mail = function (from, to) {
  let self = this;

  this._domain = this.domain || OS.hostname();

  process.nextTick(function () {
    self.connect();
  });

  return new ClientTransaction(this, from, to);
};

// Connect to the mail server.
Client.prototype.connect = function () {
  let self = this;

  if (!this._domain)
    this.emit('error', new Error('Missing required domain.'));
  else if (this.sock.readyState != 'closed')
    this.emit('error', new Error('Session already started.'));
  else {
    this.sock
      .once('connect', function () {
        self.reset(220);
      })
      .connect(this.port, this.host);
  }

  return this;
};

// Stop listening to the mail server.
Client.prototype.clear = function () {
  this.sock.removeAllListeners('data');
  return this;
};

// Switch which socket is used (see starttls).
Client.prototype.useSocket = function (sock) {
  this.sock = sock;
  return this;
};


// ### Read Responses ###

// Reset client state, say hello.
Client.prototype.reset = function (wait) {
  let self = this,
    replies = [];

  this.session = { use8BITMIME: undefined };

  U.eachLine(this.sock, function (line) {
    let probe;

    if (!(probe = line.match(/^(\d{3})([\- ])(.*)/))) {
      self.emit('error', new Error('Badly formatted reply: ' + Util.inspect(line)));
      return;
    }

    replies.push(new Reply(parseInt(probe[1]), probe[3]));

    if (probe[2] == ' ') {
      replies.unshift('reply');
      self.emit.apply(self, replies);
      replies.splice(0, replies.length);
    }
  });

  wait ? this.withReply(wait, ehlo) : ehlo();

  function ehlo() {
    self.hello(function () {
      self.emit('ready');
    });
  }

  return this;
};

Client.prototype.withReply = function (code, callback) {
  let self = this;

  if (callback === undefined)
    this.once('reply', code);
  else
    this.once('reply', function (reply) {
      if (reply.code != code)
        self.emit('error', new BadReply('Expected ' + code, reply));
      else
        callback.apply(this, arguments);
    });

  return this;
};


// ### Send Commands ##

// Write a line.
Client.prototype.puts = function (data) {
  this.write(data + '\r\n');
  return this;
};

// Write some data.
Client.prototype.write = function (data) {
  return this.sock.write(data);
};

// Write some final data, terminate the connection.
Client.prototype.end = function (data) {
  return this.sock.end(data);
};

// Send a command called `name`.
Client.prototype.command = function (name, args, callback) {
  let cmd = name.toUpperCase();

  if (typeof args == 'string')
    cmd += ' ' + args;
  this.puts(cmd);

  callback = callback || args;
  if (typeof callback == 'function')
    this.withReply(250, callback);

  return this;
};


// ### Specific Commands ###

// Say hello to the server. The server replies with a list of
// extensions it supports. Process this list of extensions by calling
// methods named `smtpEXTENSION()`.
Client.prototype.hello = function (ready) {
  let self = this;

  self.command('ehlo', self._domain, function () {
    U.aEach(arguments, extend, ready);
  });

  function extend(reply, index, next) {
    let probe = reply.text.match(/^(\S+)\s*(.*)$/),
      method = probe && self['smtp' + probe[1].toUpperCase()];

    method ? method.call(self, next, probe[2]) : next();
  }

  return self;
};

Client.prototype.quit = function () {
  this.end('QUIT\r\n');
  return this;
};


// ### STARTTLS extension ###

// See: <http://tools.ietf.org/html/rfc3207>

Client.prototype.smtpSTARTTLS = function (next) {
  let self = this;

  if (!this.useTLS)
    return next();
  else
    this.command('starttls').withReply(220, secure);

  function secure() {
    let clear = require('./starttls').starttls(self.clear().sock, false, function () {
      if (!clear.authorized)
        console.warn('STARTTLS: failed to secure stream');
      else {
        self.secure = true;
        self.useSocket(clear).reset();
      }

    });
  }

  return this;
};


// ### AUTH extension ###

// See: <http://www.faqs.org/rfcs/rfc2554.html>

Client.prototype.setLogin = function (username, password) {
  this.username = username;
  this.password = password;
  return this;
};

Client.prototype.smtpAUTH = function (next, mechanisms) {
  let names = mechanisms.toUpperCase().split(/\s+/),
    method;

  if (!this.username)
    next();
  else if (!this.secure && !this.options.insecureAuth)
    console.error('AUTH: stream is not secure (use `insecureAuth: true` to override).');
  else
    for (let i = 0, l = names.length; i < l; i++) {
      method = this['auth' + names[i]];
      if (method) {
        method.call(this, this.username, this.password, next);
        break;
      }
    }
};

// #### LOGIN mechanism ####

// See: <http://www.fehcom.de/qmail/smtpauth.html#FRAMEWORK>

Client.prototype.authLOGIN = function (username, password, next) {
  let self = this;

  this.command('auth', 'login')
    .withReply(334, sendUsername);

  function sendUsername() {
    self.puts(new Buffer(username).toString('base64'))
      .withReply(334, sendPassword);
  }

  function sendPassword() {
    self.puts(new Buffer(password).toString('base64'))
      .withReply(235, next);
  }

  return this;
};

// ### 8BITMIME Extension ###

// Default to sending 8BITMIME even if the server doesn't advertise
// support for it. If the server does advertise support, add BODY to
// the `MAIL FROM` command.
//
// To require a 7BIT body, use the `mimeTransport: '7BIT` option.
//
// See: <http://cr.yp.to/smtp/8bitmime.html>, <http://tools.ietf.org/html/rfc6152>

Client.prototype.smtp8BITMIME = function (next) {
  this.session.use8BITMIME = true;
  next();
};

Client.prototype.mimeTransport = function () {
  return this.session.use8BITMIME && (this.options.mimeTransport || '8BITMIME');
};

// Only require 7bit encoding if it's explicitly requested.
Client.prototype.require7Bit = function () {
  return this.options.mimeTransport == '7BIT';
};


// ## Reply ##

// A reply encapsulates a single reply from the server (a status code
// and a message).

function Reply(code, text) {
  this.code = code;
  this.text = text;
}

Reply.prototype.toString = function () {
  return this.code + ' ' + this.text;
};

Util.inherits(BadReply, Error);
export function BadReply(reason, reply) {
  Error.call(this, reason);
  this.reply = reply;
};

BadReply.prototype.toString = function () {
  return this.message + ': ' + this.reply.toString();
};


// ## ClientTransaction ##

// Transmit a message envelope, then notify the caller with a `ready`
// event. The caller can then use `write()` or `end()` to transmit a
// message body.

Util.inherits(ClientTransaction, Events.EventEmitter);
function ClientTransaction(client, from, to) {
  Events.EventEmitter.call(this);

  let self = this;

  this.client = client;
  this.done = false;
  this.newline = true;

  client.once('ready', sendFrom);

  function sendFrom() {
    let transport = client.mimeTransport(),
      args = '<' + from + '>' + (transport ? ' BODY=' + transport : '');

    client.command('mail from:', args, function () {
      U.aEach(to, sendTo, data);
    });
  }

  function sendTo(mailbox, index, next) {
    client.command('rcpt to:', '<' + mailbox + '>', next);
  }

  function data() {
    client.command('data').withReply(354, ready);
  }

  function ready() {
    self.emit('ready');
  }
}

Object.defineProperty(ClientTransaction.prototype, 'session', {
  get: function () {
    return this.client.session;
  }
});

ClientTransaction.prototype.write = function (data) {
  if (this.done) {
    this.client.emit('error', new Error('The transaction has ended.'));
    return this;
  }
  else if (this.client.require7Bit() && !U.is7Bit(data)) {
    this.client.emit('error', new Error('Data must be 7-bit ASCII.'));
    return this;
  }

  this.client.write(U.stuffDots(data, this.newline));
  this.newline = /\n$/.test(data);

  return this;
};

ClientTransaction.prototype.puts = function (data) {
  return this.write(data + '\r\n');
};

ClientTransaction.prototype.end = function (data) {
  let self = this;

  if (this.done)
    throw new Error('The transaction has ended.');

  if (data !== undefined)
    this.write(data);

  if (!this.newline)
    this.client.write('\r\n');
  this.client.write('.\r\n');

  this.done = true;

  this.client.withReply(250, function () {
    self.emit('end');
  });

  return this;
};

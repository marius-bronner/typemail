import * as Crypto from 'crypto';
import * as TLS from 'tls';

export function starttls(socket, opt, next) {
    if (typeof opt == 'function') {
        next = opt;
        opt = undefined;
    }

    let context = Crypto.createCredentials(undefined),
        pair: any = TLS.createSecurePair(context, false),
        cleartext = pipe(pair, socket);

    pair.on('secure', function () {
        let error = (pair.ssl) ? pair.ssl.verifyError() : pair._ssl.verifyError();

        if (error) {
            cleartext.authorized = false;
            cleartext.authorizationError = error;
        }
        else {
            cleartext.authorized = true;
        }

        next && next(error, cleartext);
    });

    cleartext._controlReleased = true;
    return cleartext;
}

// Lifted from NODE/lib/tls.js
function pipe(pair, socket) {
    pair.encrypted.pipe(socket);
    socket.pipe(pair.encrypted);

    pair.fd = socket.fd;
    let cleartext = pair.cleartext;
    cleartext.socket = socket;
    cleartext.encrypted = pair.encrypted;
    cleartext.authorized = false;

    function onerror(e) {
        if (cleartext._controlReleased) {
            cleartext.emit('error', e);
        }
    }

    function onclose() {
        socket.removeListener('error', onerror);
        socket.removeListener('close', onclose);
    }

    socket.on('error', onerror);
    socket.on('close', onclose);

    return cleartext;
}

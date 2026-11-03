/**
 * VENDORED (2026-10-09) from the matrix-js-sdk MSC4388 PoC:
 *   PR matrix-org/matrix-js-sdk#5219, branch hughns/msc4108-v2025-poc,
 *   tip 6c78790ff8ebe96007750e4c419e1958e20a45de (2026-09-24).
 * Upstream: The Matrix.org Foundation C.I.C. — Apache 2.0 (headers kept).
 *
 * Imports rewritten for the installed matrix-js-sdk 42.4.0 (root exports
 * + the deep lib/ paths this extension already uses). No other change.
 *
 * KNOWN GAP (verified 2026-10-09): the MSC4388 secure channel needs
 * HpkeRecipientChannel from @matrix-org/matrix-sdk-crypto-wasm. The HPKE
 * Rust source has landed upstream (src/vodozemac/hpke.rs) but NO published
 * wasm snapshot (18.9.0 and main HEAD) exposes the JS bindings yet — the
 * reason js-sdk PR 5219 is X-Blocked. src/qr2025/index.ts detects this at
 * probe time and self-disables the QR branch with an actionable reason
 * until the export lands. See DESIGN-LOGIN-ONBOARDING.md §16.
 */
/*
Copyright 2026 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {
    HpkeRecipientChannel,
    type EstablishedHpkeChannel,
    QrCodeData,
    type QrCodeIntent,
} from "@matrix-org/matrix-sdk-crypto-wasm";

import {
    ClientRendezvousFailureReason,
    type MSC4108FailureReason,
    RendezvousError,
    type RendezvousFailureListener,
} from "matrix-js-sdk/lib/rendezvous/index.js";
import { type MSC4388RendezvousSession } from "./MSC4388RendezvousSession.js";
import { logger } from "matrix-js-sdk/lib/logger.js";
import { type MSC4108v2025Payload } from "./MSC4108v2025SignInWithQR.js";

/**
 * Prototype of the unstable [MSC4388](https://github.com/matrix-org/matrix-spec-proposals/pull/4388)
 * secure rendezvous session protocol.
 * @experimental Note that this is UNSTABLE and may have breaking changes without notice.
 * Imports @matrix-org/matrix-sdk-crypto-wasm so should be async-imported to avoid bundling the WASM into the main bundle.
 */
export class MSC4388SecureChannel {
    private readonly recipientChannel: HpkeRecipientChannel;
    private establishedChannel?: EstablishedHpkeChannel;
    private connected = false;

    public constructor(
        private readonly rendezvousSession: MSC4388RendezvousSession,
        public readonly intent: QrCodeIntent,
        public onFailure?: RendezvousFailureListener,
    ) {
        this.recipientChannel = new HpkeRecipientChannel();
    }

    /**
     * Generate a QR code for the current session.
     * @param mode the mode to generate the QR code in, either `Login` or `Reciprocate`.
     */
    public async generateCode(): Promise<Uint8Array> {
        const { id, baseUrl } = this.rendezvousSession;

        if (!id) {
            throw new Error("No rendezvous session ID");
        }

        if (!baseUrl) {
            throw new Error("No rendezvous session base URL");
        }
        return QrCodeData.newMsc4388(this.recipientChannel.publicKey, id, baseUrl, this.intent).toBytes();
    }

    /**
     * Returns the check code for the secure channel or undefined if not generated yet.
     */
    public getCheckCode(): string | undefined {
        const x = this.establishedChannel?.checkCode;

        if (!x) {
            return undefined;
        }

        // in this version of the MSC the is never a leading zero
        return String(x.to_digit());
    }

    /**
     * Connects and establishes a secure channel with the other device.
     */
    public async connect(): Promise<void> {
        if (this.connected) {
            throw new Error("Channel already connected");
        }

        // We are device G: the generating device

        // wait for the other side to send us their public key
        logger.info("Waiting for LoginInitiateMessage");
        const loginInitiateMessage = await this.rendezvousSession.receive();
        if (!loginInitiateMessage) {
            throw new Error("No response from other device");
        }

        logger.info("Received LoginInitiateMessage");

        const { channel: unidirectionalChannel, message: candidateLoginInitiateMessage } =
            this.recipientChannel.establishChannel(
                loginInitiateMessage,
                this.rendezvousSession.getAdditionalAuthenticationDataForReceive(),
            );

        // Verify LoginInitiateMessage
        if (candidateLoginInitiateMessage !== "MATRIX_QR_CODE_LOGIN_INITIATE") {
            throw new RendezvousError(
                "Invalid response from other device",
                ClientRendezvousFailureReason.InsecureChannelDetected,
            );
        }
        logger.info("LoginInitiateMessage received");

        logger.info("Sending LoginOkMessage");
        const { channel, initialResponse: loginOkMessage } = unidirectionalChannel.establishBidirectionalChannel(
            "MATRIX_QR_CODE_LOGIN_OK",
            this.rendezvousSession.getAdditionalAuthenticationDataForSend(),
        );

        await this.rendezvousSession.send(loginOkMessage);

        this.establishedChannel = channel;

        // Step 5 is complete. We, device G, don't yet trust the channel

        // next step will be for the user to confirm the check code on the other device

        this.connected = true;
    }

    private async decrypt(ciphertext: string): Promise<string> {
        if (!this.establishedChannel) {
            throw new Error("Channel closed");
        }

        return this.establishedChannel.open(
            ciphertext,
            this.rendezvousSession.getAdditionalAuthenticationDataForReceive(),
        );
    }

    private async encrypt(plaintext: string): Promise<string> {
        if (!this.establishedChannel) {
            throw new Error("Channel closed");
        }

        return this.establishedChannel.seal(plaintext, this.rendezvousSession.getAdditionalAuthenticationDataForSend());
    }

    /**
     * Sends a payload securely to the other device.
     * @param payload the payload to encrypt and send
     */
    public async secureSend<T extends MSC4108v2025Payload>(payload: T): Promise<void> {
        if (!this.connected) {
            throw new Error("Channel closed");
        }

        const stringifiedPayload = JSON.stringify(payload);
        logger.debug(`=> {"type": ${JSON.stringify(payload.type)}, ...}`);

        await this.rendezvousSession.send(await this.encrypt(stringifiedPayload));
    }

    /**
     * Receives an encrypted payload from the other device and decrypts it.
     */
    public async secureReceive<T extends MSC4108v2025Payload>(): Promise<Partial<T> | undefined> {
        if (!this.establishedChannel) {
            throw new Error("Channel closed");
        }

        const ciphertext = await this.rendezvousSession.receive();
        if (!ciphertext) {
            return undefined;
        }
        const plaintext = await this.decrypt(ciphertext);
        const json = JSON.parse(plaintext);

        logger.debug(`<= {"type": ${JSON.stringify(json.type)}, ...}`);
        return json as Partial<T> | undefined;
    }

    /**
     * Closes the secure channel.
     */
    public async close(): Promise<void> {
        await this.rendezvousSession.close();
    }

    /**
     * Cancels the secure channel.
     * @param reason the reason for the cancellation
     */
    public async cancel(reason: MSC4108FailureReason | ClientRendezvousFailureReason): Promise<void> {
        try {
            await this.rendezvousSession.cancel(reason);
            this.onFailure?.(reason);
        } finally {
            await this.close();
        }
    }

    /**
     * Returns whether the rendezvous session has been cancelled.
     */
    public get cancelled(): boolean {
        return this.rendezvousSession.cancelled;
    }
}

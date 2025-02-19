import type { CrossChainMessage, DeepPartial, OEContractsLike } from "@eth-optimism/sdk";
import {
  CrossChainMessenger,
  hashLowLevelMessage,
  MessageReceiptStatus,
  MessageStatus,
} from "@eth-optimism/sdk";
import type { TransactionResponse } from "@ethersproject/providers";

import type { TransactionHash } from "../types";
import { BaseRelayerService } from "../types";

export class OptimismRelayerService extends BaseRelayerService {
  customNetworkContracts: DeepPartial<OEContractsLike> | undefined;
  messenger: CrossChainMessenger | undefined;

  /**
   *  We utilize a little "hack" in the Optimism Contracts for properly estimating the min. gas required for relaying the message.
   *  When doing the estimation via `estimateGas` we provide the ESTIMATION_ADDRESS as the "from" address so it hits the right "spots" in the contracts
   *  in order to force the estimation algorithm to return the right gasLimit estimation.
   *  https://github.com/ethereum-optimism/optimism/blob/develop/packages/contracts-bedrock/contracts/universal/CrossDomainMessenger.sol#L381-L388
   *  Without this, the estimated min. gas returned when estimating the `CrossDomainMessenger.relayMessage` is wrong.
   *
   *  Note: With a wrong min. gas limit estimation, the submitted transactions to the OptimismPortal & CrossChainMessenger will
   *  always succeed even if the underlying message was not relayed successfully due to missing gas.
   *
   *  Another benefit of this is catching reverts when relaying messages that are destined to fail due to other issues unrelated to the gasLimit:
   *  - https://github.com/ethereum-optimism/optimism/blob/develop/packages/contracts-bedrock/contracts/L1/OptimismPortal.sol#L417
   *  - https://github.com/ethereum-optimism/optimism/blob/develop/packages/contracts-bedrock/contracts/universal/CrossDomainMessenger.sol#L409-L411
   *
   *
   * The value of this constant is defined here: https://github.com/ethereum-optimism/optimism/blob/develop/packages/contracts-bedrock/contracts/libraries/Constants.sol#L14-L21
   * */
  readonly ESTIMATION_ADDRESS = "0x0000000000000000000000000000000000000001";

  constructor(...args: ConstructorParameters<typeof BaseRelayerService>) {
    super(...args);

    this.messenger = new CrossChainMessenger({
      l1SignerOrProvider: this.l1Wallet,
      l2SignerOrProvider: this.l2Wallet,
      l1ChainId: this.l1ChainId,
      l2ChainId: this.l2ChainId,
      contracts: this.customNetworkContracts ?? {},
      bedrock: true,
    });
  }

  async getMessageInTransaction(l2TransactionHash: TransactionHash) {
    const messages = await this.messenger.getMessagesByTransaction(l2TransactionHash);

    // No messages in this transaction, so there's nothing to do
    if (messages.length === 0) {
      throw new Error(`No message found in L2 transaction ${l2TransactionHash}.`);
    }
    if (messages.length > 1) {
      throw new Error(`Multiple messages found in L2 transaction ${l2TransactionHash}.`);
    }

    return messages[0];
  }

  isMessageProved(messageStatus: MessageStatus): boolean {
    return [
      MessageStatus.READY_FOR_RELAY,
      MessageStatus.RELAYED,
      MessageStatus.IN_CHALLENGE_PERIOD,
    ].includes(messageStatus);
  }

  async proveMessage(l2TransactionHash: TransactionHash) {
    console.log(`\nProving OP message on L1 for L2 Transaction hash: ${l2TransactionHash}`);

    await this.l2RpcProvider.waitForTransaction(l2TransactionHash, 1);
    const message = await this.getMessageInTransaction(l2TransactionHash);
    const status = await this.messenger.getMessageStatus(message);

    console.log(`Message status: ${MessageStatus[status]}`);
    if (this.isMessageProved(status)) {
      console.log(`Message already proven.`);
      return;
    }

    if (status !== MessageStatus.READY_TO_PROVE) {
      console.log("Message not ready to be proven. Waiting...");
    }
    await this.messenger.waitForMessageStatus(message, MessageStatus.READY_TO_PROVE);

    // Now we can prove the message on L1
    console.log("Proving message...");
    const tx = await this.messenger.proveMessage(message);
    const receipt = await tx.wait(1);
    if (!receipt.status) {
      throw new Error(
        `Message proving failed - transaction reverted on chain! Transaction hash: ${receipt.transactionHash}`,
      );
    }

    console.log(`Message successfully proven with L1 transaction hash: ${tx.hash}`);
    return;
  }

  private async getMessageWithdrawalHash(message: CrossChainMessage): Promise<string> {
    const crossChainMessage = await this.messenger.toBedrockCrossChainMessage(message);
    const lowLevelMessage = await this.messenger.toLowLevelMessage(crossChainMessage);

    return hashLowLevelMessage(lowLevelMessage);
  }

  private async isMessageWithdrawn(messageHash: string) {
    const OptimismPortal = this.messenger.contracts.l1.OptimismPortal.connect(this.l1Wallet);
    const isWithdrawn = await OptimismPortal.finalizedWithdrawals(messageHash);

    return isWithdrawn;
  }

  private async relayMessageViaCrossDomainMessenger(
    message: CrossChainMessage,
  ): Promise<TransactionResponse> {
    const lowLevelMessage = await this.messenger.toLowLevelMessage(message);

    const gasLimit = await this.l1Wallet.provider.estimateGas({
      from: this.ESTIMATION_ADDRESS,
      to: this.messenger.contracts.l1.L1CrossDomainMessenger.address,
      data: lowLevelMessage.message,
    });

    return await this.l1Wallet.sendTransaction({
      to: this.messenger.contracts.l1.L1CrossDomainMessenger.address,
      // lowLevelMessage.message contains the complete transaction data
      data: lowLevelMessage.message,
      gasLimit,
    });
  }

  private async relayMessageViaOptimismPortal(
    message: CrossChainMessage,
  ): Promise<TransactionResponse> {
    const lowLevelMessage = await this.messenger.toLowLevelMessage(message);

    const OptimismPortalContract = await this.messenger.contracts.l1.OptimismPortal.connect(
      this.l1RpcProvider,
    );
    const gasLimit = await OptimismPortalContract.estimateGas.finalizeWithdrawalTransaction(
      [
        lowLevelMessage.messageNonce,
        lowLevelMessage.sender,
        lowLevelMessage.target,
        lowLevelMessage.value,
        lowLevelMessage.minGasLimit,
        lowLevelMessage.message,
      ],
      {
        from: this.ESTIMATION_ADDRESS,
      },
    );

    // Finalize message via OptimismPortal (it calls the L1CrossDomainMessenger internally)
    return await this.messenger.finalizeMessage(message, {
      overrides: {
        gasLimit,
      },
    });
  }

  /**
   * Since OP Bedrock, the relay process consists of 2 contract calls.
   * 1. A call to `OptimismPortal.finalizeWithdrawalTransaction` - initiates the relay by doing certain checks & forwarding the call
   * 2. A call to `CrossDomainMessenger.relayMessage` that was forwarded by the OptimismPortal in the previous step which in the end executes our message on L1.
   *
   * The first call will always result in a successful transaction no matter the status of the underlying call (CrossDomainMessenger.relayMessage).
   * When the underlying message execution on L1 failed, we have no way to replay the relay process via the OptimismPortal anymore as
   * the message was marked as withdrawn in the first call.
   * What we need to do instead is to go via the `CrossDomainMessenger.relayMessage` to replay a message relay.
   *
   * This function takes care of handling these failures by deciding on which route should be used.
   */
  private async safeRelayMessage(message: CrossChainMessage): Promise<boolean> {
    const withdrawalHash = await this.getMessageWithdrawalHash(message);
    const isWithdrawn = await this.isMessageWithdrawn(withdrawalHash);
    let tx = null;

    if (!isWithdrawn) {
      console.log("Try relaying via Optimism Portal..");
      tx = await this.relayMessageViaOptimismPortal(message);
    } else {
      // Here, the case was that OptimismPortal marked the withdrawal as finalized but the relay probably failed
      // We need to call the L1CrossDomainMessenger to relay the message for us instead of going via the OptimismPortal
      console.log("Try relaying via CrossDomainMessenger..");
      tx = await this.relayMessageViaCrossDomainMessenger(message);
    }

    await tx.wait(1);

    return true;
  }

  async prepare(): Promise<boolean> {
    return true;
  }

  async relayTxToL1(l2TransactionHash: TransactionHash): Promise<TransactionHash | undefined> {
    console.log("Optimism outbox execution.");

    await this.l2RpcProvider.waitForTransaction(l2TransactionHash, 1);
    const message = await this.getMessageInTransaction(l2TransactionHash);
    const status = await this.messenger.getMessageStatus(message);

    console.log(`Message status: ${MessageStatus[status]}`);
    if (status === MessageStatus.RELAYED) {
      const receipt = await this.messenger.waitForMessageReceipt(message);
      console.log(
        `Message already relayed with tx hash: ${receipt.transactionReceipt.transactionHash}`,
      );
      return receipt.transactionReceipt.transactionHash;
    }

    // Now we can relay the message to L1.
    console.log("Relaying...");

    await this.safeRelayMessage(message);
    const receipt = await this.messenger.waitForMessageReceipt(message);

    console.log(`Transaction hash: ${receipt.transactionReceipt.transactionHash}`);
    if (receipt.receiptStatus === MessageReceiptStatus.RELAYED_SUCCEEDED) {
      console.log("Message successfully relayed!");
      return receipt.transactionReceipt.transactionHash;
    } else {
      throw new Error("Message relaying failed!");
    }
  }

  async finalize(): Promise<void> {
    return;
  }
}

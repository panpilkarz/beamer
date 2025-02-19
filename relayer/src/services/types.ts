import type { Provider } from "@ethersproject/providers";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Wallet } from "ethers";

import type { ArbitrumRelayerService } from "./relayer/arbitrum";
import type { BobaRelayerService } from "./relayer/boba";
import type { EthereumRelayerService } from "./relayer/ethereum";
import type { OptimismRelayerService } from "./relayer/optimism";
import type { PolygonZKEvmRelayerService } from "./relayer/polygon-zkevm";

export type TransactionHash = string;

export type ExtendedRelayerService =
  | typeof ArbitrumRelayerService
  | typeof BobaRelayerService
  | typeof OptimismRelayerService
  | typeof EthereumRelayerService
  | typeof PolygonZKEvmRelayerService;

export abstract class BaseRelayerService {
  readonly l1RpcUrl: string;
  readonly l2RpcUrl: string;
  readonly l1Wallet: Wallet;
  readonly l2Wallet: Wallet;
  readonly l1ChainId: number;
  readonly l2ChainId: number;
  readonly destinationChainId?: number;

  constructor(
    l1RpcURL: string,
    l2RpcURL: string,
    privateKey: string,
    l1ChainId: number,
    l2ChainId: number,
    destinationChainId?: number,
    customNetworkFilePath?: string,
  ) {
    this.l1RpcUrl = l1RpcURL;
    this.l2RpcUrl = l2RpcURL;
    this.l1Wallet = new Wallet(privateKey, new JsonRpcProvider(l1RpcURL));
    this.l2Wallet = new Wallet(privateKey, new JsonRpcProvider(l2RpcURL));
    this.l1ChainId = l1ChainId;
    this.l2ChainId = l2ChainId;
    this.destinationChainId = destinationChainId ?? undefined;
    if (customNetworkFilePath) {
      this.addCustomNetwork(customNetworkFilePath);
    }
  }

  get l2RpcProvider(): Provider {
    return this.l2Wallet.provider;
  }

  get l1RpcProvider(): Provider {
    return this.l1Wallet.provider;
  }

  async getL1ChainId() {
    return (await this.l1RpcProvider.getNetwork()).chainId;
  }

  async getL2ChainId() {
    return (await this.l2RpcProvider.getNetwork()).chainId;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  addCustomNetwork(_filePath: string): void {
    return;
  }

  abstract prepare(): Promise<boolean>;
  abstract relayTxToL1(l2TransactionHash: TransactionHash): Promise<TransactionHash | undefined>;
  abstract finalize(l1TransactionHash: TransactionHash): Promise<void>;
}

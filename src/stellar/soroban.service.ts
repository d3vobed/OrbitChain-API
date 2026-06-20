import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  rpc,
  TransactionBuilder,
  Contract,
  Account,
  Keypair,
  xdr,
  scValToNative,
  nativeToScVal,
  Transaction,
  FeeBumpTransaction,
} from '@stellar/stellar-sdk';

@Injectable()
export class SorobanService {
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly serverKeypair?: Keypair;
  private readonly feeBumpKeypair?: Keypair;

  constructor(private readonly config: ConfigService) {
    const rpcUrl =
      this.config.get<string>('STELLAR_RPC_URL') ||
      'https://soroban-testnet.stellar.org:443';
    this.server = new rpc.Server(rpcUrl);
    this.networkPassphrase =
      this.config.get<string>('STELLAR_NETWORK_PASSPHRASE') ||
      'Test SDF Network ; September 2015';

    const serverSecret = this.config.get<string>('STELLAR_SERVER_SECRET');
    if (serverSecret) {
      try {
        this.serverKeypair = Keypair.fromSecret(serverSecret);
      } catch (err) {
        console.error('Failed to parse STELLAR_SERVER_SECRET:', err.message);
      }
    }

    const feeBumpSecret = this.config.get<string>('STELLAR_FEE_BUMP_SECRET');
    if (feeBumpSecret) {
      try {
        this.feeBumpKeypair = Keypair.fromSecret(feeBumpSecret);
      } catch (err) {
        console.error('Failed to parse STELLAR_FEE_BUMP_SECRET:', err.message);
      }
    }
  }

  getServer(): rpc.Server {
    return this.server;
  }

  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  getServerKeypair(): Keypair | undefined {
    return this.serverKeypair;
  }

  getFeeBumpKeypair(): Keypair | undefined {
    return this.feeBumpKeypair;
  }

  /** Simulate a Soroban contract read call without submitting a transaction */
  async readContractData(
    contractId: string,
    functionName: string,
    args: any[] = [],
  ): Promise<any> {
    try {
      const scValArgs = args.map((arg) => nativeToScVal(arg));
      const contract = new Contract(contractId);
      const operation = contract.call(functionName, ...scValArgs);

      const sourceAddress =
        this.serverKeypair?.publicKey() ||
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
      const source = new Account(sourceAddress, '0');

      const tx = new TransactionBuilder(source, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);

      if (
        simulation &&
        'result' in simulation &&
        simulation.result &&
        'retval' in simulation.result
      ) {
        return scValToNative(simulation.result.retval);
      } else {
        throw this.parseSimulationError(simulation);
      }
    } catch (error) {
      throw this.parseSimulationError(error);
    }
  }

  /** Submit and sign a Soroban contract invocation, optionally with fee bump */
  async invokeContract(
    contractId: string,
    functionName: string,
    args: any[],
    signerKeypair?: Keypair,
    options?: { feeBumpKeypair?: Keypair },
  ): Promise<any> {
    const finalSigner = signerKeypair || this.serverKeypair;
    if (!finalSigner) {
      throw new BadRequestException(
        'No signer keypair provided and no server keypair is configured',
      );
    }

    try {
      const scValArgs = args.map((arg) => nativeToScVal(arg));
      const contract = new Contract(contractId);
      const operation = contract.call(functionName, ...scValArgs);

      const sourceAccount = await this.server.getAccount(
        finalSigner.publicKey(),
      );

      const tx = new TransactionBuilder(sourceAccount, {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      let preparedTx: Transaction | FeeBumpTransaction;
      try {
        preparedTx = await this.server.prepareTransaction(tx);
      } catch (prepError) {
        throw this.parseSimulationError(prepError);
      }

      preparedTx.sign(finalSigner);

      let finalTx: Transaction | FeeBumpTransaction = preparedTx;
      const feeBumpKeypair = options?.feeBumpKeypair || this.feeBumpKeypair;
      if (feeBumpKeypair) {
        finalTx = TransactionBuilder.buildFeeBumpTransaction(
          feeBumpKeypair.publicKey(),
          '200',
          preparedTx,
          this.networkPassphrase,
        );
        finalTx.sign(feeBumpKeypair);
      }

      const response = await this.server.sendTransaction(finalTx);

      if (response.status === 'ERROR') {
        throw this.parseTxResultError(
          (response as any).errorResultXdr || (response as any).errorResult,
        );
      }

      const txResult = await this.pollTransaction(response.hash);

      if (txResult.status === 'SUCCESS') {
        if (txResult.resultXdr) {
          const parsedResult = xdr.TransactionResult.fromXDR(
            txResult.resultXdr,
            'base64',
          );
          const opResults = parsedResult.result().results();
          if (opResults && opResults.length > 0) {
            const invokeHostFuncResult = opResults[0]
              .tr()
              .invokeHostFunctionResult();
            const innerSwitch = invokeHostFuncResult.switch().name;
            if (innerSwitch === 'invokeHostFunctionSuccess') {
              const scValResult = invokeHostFuncResult.success();
              return scValToNative(scValResult as any);
            }
          }
        }
        return null;
      } else {
        throw this.parseTxResultError(txResult.resultXdr);
      }
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error.message.includes('panic') ||
        error.message.includes('Simulation')
      ) {
        throw error;
      }
      throw new Error(`Soroban contract invocation failed: ${error.message}`);
    }
  }

  private async pollTransaction(
    hash: string,
    maxAttempts = 15,
    intervalMs = 1500,
  ): Promise<any> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await this.server.getTransaction(hash);
      if (response.status === 'SUCCESS' || response.status === 'FAILED') {
        return response;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Transaction polling timed out for hash ${hash}`);
  }

  private parseSimulationError(error: any): Error {
    if (!error) {
      return new Error('Soroban simulation failed with an unknown error');
    }
    if (error.error) {
      return new Error(`Soroban simulation failed: ${error.error}`);
    }
    if (error.simulationResult && error.simulationResult.error) {
      return new Error(
        `Soroban simulation failed: ${error.simulationResult.error}`,
      );
    }
    if (error.message) {
      return new Error(`Soroban simulation failed: ${error.message}`);
    }
    return new Error('Soroban simulation failed with an unknown error');
  }

  private parseTxResultError(resultXdr: string): Error {
    if (!resultXdr) {
      return new Error('Transaction failed with no result XDR');
    }
    try {
      const txResult = xdr.TransactionResult.fromXDR(resultXdr, 'base64');
      const resultType = txResult.result().switch().name;

      if (resultType === 'txFailed') {
        const results = txResult.result().results();
        if (results && results.length > 0) {
          const opResult = results[0];
          const opResultType = opResult.switch().name;
          if (opResultType === 'opInner') {
            const innerResult = opResult.tr().invokeHostFunctionResult();
            const innerSwitch = innerResult.switch().name;
            if (innerSwitch === 'invokeHostFunctionTrapped') {
              return new Error(
                'Soroban contract panic: execution trapped (contract panic)',
              );
            } else if (
              innerSwitch === 'invokeHostFunctionResourceLimitExceeded'
            ) {
              return new Error(
                'Soroban contract panic: resource limit exceeded',
              );
            } else {
              return new Error(`Soroban contract panic: ${innerSwitch}`);
            }
          }
        }
      }
      return new Error(`Transaction failed: ${resultType}`);
    } catch (err) {
      return new Error(
        `Transaction failed (failed to parse resultXdr: ${err.message})`,
      );
    }
  }
}

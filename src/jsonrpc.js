import bluebird from 'bluebird';
import { defaultBlockNumber, defaultFromBlockNumber } from './config';
import web3 from './web3/web3Provider';
import logger from './logger';
import { isInArray } from './utils';
import { isAddress, validateBlockNumber } from './web3/utils';
import initCustomRPCs from './web3/customeRpc';

export default class JsonRpc {
  /**
   * Initialize class local variables
   * @param Array addresses
   * @param int currentBlock
   * @param int toBlock
   * @param function callback
   */
  constructor(addresses, fromBlock, toBlock, callback = null) {
    this.addresses = addresses.map((address) => {
      if (!isAddress(address)) { throw new Error(`${address} is not valid address`); }
      return address.toLowerCase();
    });

    this.currentBlock = fromBlock !== defaultBlockNumber ? fromBlock : defaultFromBlockNumber;
    this.toBlock = toBlock !== defaultBlockNumber ? toBlock : null;
    this.web3Instance = web3.eth;
    this.callback = callback;
    if (!callback) {
      logger.info('Warning!: No callback function defined');
    }
  }
  /**
   * This will return the final data structure
   * for the transaction resopnse
   * @param string tx
   * @param Object receipt
   * @param Array logs
   * @return object
   */
  static getTransactionFormat(transaction, receipt, logs) {
    const receiptResult = receipt;

    receiptResult.logs = logs;
    return { ...transaction, ...receiptResult };
  }

  /**
   * This will return the final data structure
   * for the transaction resopnse
   * @param string tx
   * @param Object receipt
   * @param Array logs
   * @return object
   */
  static getBlockAndTransactionLogsFormat(block, logs) {
    const transactionLogs = {};
    logs.forEach((log) => {
      if (!Array.isArray(transactionLogs[log.transactionHash])) {
        transactionLogs[log.transactionHash] = [];
      }
      transactionLogs[log.transactionHash].push(log);
    });
    const result = [];
    block.transactions.forEach((transaction) => {
      const transactionObject = transaction;
      if (typeof transactionLogs[transactionObject.hash] !== 'undefined') {
        transactionObject.logs = transactionLogs[transactionObject.hash];
      } else { transactionObject.logs = []; }

      result.push(transactionObject);
    });

    return result;
  }


  /**
   * Async function that gets the transaction and transaction receipt
   * then get the logs out of the receipt transaction then execute the callback function
   * @param string txn
   */
  async _scanTransaction(txn) {
    const txnReceipts = await bluebird.promisify(this.web3Instance.getTransactionReceipt)(txn.hash);
    const logs = txnReceipts.logs ? txnReceipts.logs.filter(log => isInArray(this.addresses,
      log.address)) : [];

    if (txn.from && isInArray(this.addresses, txn.from.toLowerCase())) {
      throw new Error('Address you entered is not a smart contract');
    }

    // If the smart contract recieved transaction or there's logs execute the callback function
    if ((txn.to && isInArray(this.addresses, txn.to.toLowerCase())) || logs.length > 0) {
      const transactionResult = JsonRpc.getTransactionFormat(txn, txnReceipts, logs);
      if (this.callback) { await this.callback(transactionResult); }
    }
  }

  /**
   * This function handles the transactions that exist in one block
   *  and puts them into an array of promises, then executes them.
   * @param Object block
   */
  async _scanBlockCallback(block) {
    if (block && block.transactions && Array.isArray(block.transactions)) {
      const promises = [];
      for (let i = 0; i < block.transactions.length; i += 1) {
        const txn = block.transactions[i];
        promises.push(this._scanTransaction(txn));
      }
      await Promise.all(promises);
    }
  }


  /**
   * The main function that run scan all the blocks without the transaction - fastmode -.
   */
  async getLogsFromOneBlock() {
    const blockNumber = web3.toHex(this.currentBlock);
    const customRpc = initCustomRPCs();
    return customRpc.getLogs({
      address: this.addresses[0],
      fromBlock: blockNumber,
      toBlock: blockNumber,
      topics: [] });
  }


  /**
   * The main function that run scan all the blocks.
   */
  async scanBlocks(isFastMode = false) {
    let lastBlockNumber = await bluebird.promisify(this.web3Instance.getBlockNumber)();
    validateBlockNumber(lastBlockNumber, this.currentBlock);
    if (this.toBlock) {
      validateBlockNumber(lastBlockNumber, this.toBlock);
    }

    while ((this.toBlock && this.toBlock >= this.currentBlock) || (this.toBlock == null)) {
      try {
        if (this.currentBlock > lastBlockNumber) {
          logger.info('Waiting 10 seconds until the incoming blocks');
          await bluebird.delay(10000);
          lastBlockNumber = await bluebird.promisify(this.web3Instance.getBlockNumber)();
        } else {
          const block = await bluebird.promisify(this.web3Instance.getBlock)(
            this.currentBlock, true);

          if (isFastMode) {
            const logs = await this.getLogsFromOneBlock();
            const blockTransactionsWithLogsList =
            JsonRpc.getBlockAndTransactionLogsFormat(block, logs);

            if (this.callback) {
              blockTransactionsWithLogsList.forEach((transaction) => {
                this.callback(transaction);
              });
            }
          } else {
            await this._scanBlockCallback(block);
          }
          this.currentBlock = parseInt(this.currentBlock, 10) + 1;
          logger.debug(`Current block number is ${this.currentBlock}`);
        }
      } catch (e) {
        if (e.message === 'Invalid JSON RPC response: ""') {
          logger.error(`Network error ocurar, retry after 2 seconds, from block number \
${this.currentBlock}`);
          await bluebird.delay(2000);
        } else {
          throw new Error(e.message);
        } // end if
      } // end catch
    } // end loop
  }
}

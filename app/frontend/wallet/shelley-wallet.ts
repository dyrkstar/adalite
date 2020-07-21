import debugLog from '../helpers/debugLog'
import AddressManager from './address-manager'
import BlockchainExplorer from './blockchain-explorer'
import PseudoRandom from './helpers/PseudoRandom'
import {MAX_INT32} from './constants'
import NamedError from '../helpers/NamedError'
import {Lovelace} from '../state'
import {
  stakeAccountPubkeyHex,
  ShelleyStakingAccountProvider,
  ShelleyBaseAddressProvider,
} from './shelley/shelley-address-provider'

import {computeRequiredTxFee} from './shelley/helpers/chainlib-wrapper'
import {selectMinimalTxPlan} from './shelley/shelley-transaction-planner'
import shuffleArray from './helpers/shuffleArray'
import {MaxAmountCalculator} from './max-amount-calculator'
import {ByronAddressProvider} from './byron/byron-address-provider'
import {
  isShelleyFormat,
  bechAddressToHex,
  isBase,
  base58AddressToHex,
} from './shelley/helpers/addresses'
import request from './helpers/request'
import {ADALITE_CONFIG} from '../config'

const isUtxoProfitable = () => true

const MyAddresses = ({accountIndex, cryptoProvider, gapLimit, blockchainExplorer}) => {
  const legacyExtManager = AddressManager({
    addressProvider: ByronAddressProvider(cryptoProvider, accountIndex, false),
    gapLimit,
    blockchainExplorer,
  })

  const legacyIntManager = AddressManager({
    addressProvider: ByronAddressProvider(cryptoProvider, accountIndex, true),
    gapLimit,
    blockchainExplorer,
  })

  const accountAddrManager = AddressManager({
    addressProvider: ShelleyStakingAccountProvider(cryptoProvider, accountIndex),
    gapLimit: 1,
    blockchainExplorer,
  })

  const baseExtAddrManager = AddressManager({
    addressProvider: ShelleyBaseAddressProvider(cryptoProvider, accountIndex, false),
    gapLimit,
    blockchainExplorer,
  })

  const baseIntAddrManager = AddressManager({
    addressProvider: ShelleyBaseAddressProvider(cryptoProvider, accountIndex, true),
    gapLimit,
    blockchainExplorer,
  })

  async function discoverAllAddresses() {
    const baseInt = await baseIntAddrManager.discoverAddresses()
    const baseExt = await baseExtAddrManager.discoverAddresses()
    const legacyInt = await legacyIntManager.discoverAddresses()
    const legacyExt = await legacyExtManager.discoverAddresses()
    const accountAddr = await accountAddrManager._deriveAddress(accountIndex)

    const isV1scheme = cryptoProvider.getDerivationScheme().type === 'v1'
    return {
      legacy: isV1scheme ? [...legacyInt] : [...legacyInt, ...legacyExt],
      base: [...baseInt, ...baseExt],
      account: accountAddr,
    }
  }

  function getAddressToAbsPathMapper() {
    const mapping = Object.assign(
      {},
      legacyIntManager.getAddressToAbsPathMapping(),
      legacyExtManager.getAddressToAbsPathMapping(),
      baseIntAddrManager.getAddressToAbsPathMapping(),
      baseExtAddrManager.getAddressToAbsPathMapping(),
      accountAddrManager.getAddressToAbsPathMapping()
    )
    return (address) => mapping[address]
  }

  function fixedPathMapper() {
    const mappingLegacy = {
      ...legacyIntManager.getAddressToAbsPathMapping(),
      ...legacyExtManager.getAddressToAbsPathMapping(),
    }
    const mappingShelley = {
      ...baseIntAddrManager.getAddressToAbsPathMapping(),
      ...baseExtAddrManager.getAddressToAbsPathMapping(),
      ...accountAddrManager.getAddressToAbsPathMapping(),
    }

    const fixedShelley = {}
    for (const key in mappingShelley) {
      fixedShelley[bechAddressToHex(key)] = mappingShelley[key]
    }

    return (address) => mappingLegacy[address] || fixedShelley[address] || mappingShelley[address]
  }

  async function getVisibleAddressesWithMeta() {
    const addresses = await baseExtAddrManager.discoverAddressesWithMeta()
    return addresses //filterUnusedEndAddresses(addresses, config.ADALITE_DEFAULT_ADDRESS_COUNT)
  }

  async function getChangeAddress(rngSeed: number): Promise<string> {
    /*
    * We use visible addresses as change addresses to mainintain
    * AdaLite original functionality which did not consider change addresses.
    * This is an intermediate step between legacy mode and full Yoroi compatibility.
    */
    const candidates = await getVisibleAddressesWithMeta()

    const randomSeedGenerator = PseudoRandom(rngSeed)
    const choice = candidates[randomSeedGenerator.nextInt() % candidates.length]
    return choice.address
  }

  return {
    getAddressToAbsPathMapper,
    fixedPathMapper,
    discoverAllAddresses,
    // TODO(refactor)
    baseExtAddrManager,
    accountAddrManager,
    getChangeAddress,
    getVisibleAddressesWithMeta,
  }
}

const ShelleyBlockchainExplorer = (config) => {
  // TODO: move methods to blockchain-explorer file
  const be = BlockchainExplorer(config)

  const addressToHex = (address) =>
    isShelleyFormat(address) ? bechAddressToHex(address) : base58AddressToHex(address)

  const addressesToHex = (addresses: Array<string>): Array<string> => addresses.map(addressToHex)

  async function getAccountInfo(accountPubkeyHex) {
    const url = `${
      ADALITE_CONFIG.ADALITE_BLOCKCHAIN_EXPLORER_URL
    }/api/account/info/${accountPubkeyHex}`
    const response = await request(url)
    return response
  }

  async function getValidStakepools() {
    const url = `${ADALITE_CONFIG.ADALITE_BLOCKCHAIN_EXPLORER_URL}/api/stakePools`
    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        body: null,
        headers: {
          'content-Type': 'application/json',
        },
      })
      if (response.status >= 400) {
        throw NamedError('NetworkError', 'Unable to fetch running stakepools.')
      }
    } catch (e) {
      throw NamedError('NetworkError', e.message)
    }
    const poolArray = JSON.parse(await response.text())
    const validStakepools = poolArray.reduce(
      // eslint-disable-next-line no-sequences
      (dict, el) => ((dict[el.poolHash] = {...el}), dict),
      {}
    )
    return {validStakepools}
  }

  async function getPoolInfo(url) {
    const response = await request(url).catch(() => {
      return {}
    })
    return response
  }

  return {
    getTxHistory: (addresses) => be.getTxHistory(addressesToHex(addresses)),
    fetchTxRaw: be.fetchTxRaw,
    fetchUnspentTxOutputs: (addresses) => be.fetchUnspentTxOutputs(addressesToHex(addresses)),
    isSomeAddressUsed: (addresses) => be.isSomeAddressUsed(addressesToHex(addresses)),
    submitTxRaw: be.submitTxRaw,
    getBalance: (addresses) => be.getBalance(addressesToHex(addresses)),
    fetchTxInfo: be.fetchTxInfo,
    filterUsedAddresses: (addresses) => be.filterUsedAddresses(addressesToHex(addresses)),
    getAccountInfo,
    getValidStakepools,
    getPoolInfo,
  }
}
const ShelleyWallet = ({config, randomInputSeed, randomChangeSeed, cryptoProvider}: any) => {
  const {
    getMaxDonationAmount: _getMaxDonationAmount,
    getMaxSendableAmount: _getMaxSendableAmount,
  } = MaxAmountCalculator(computeRequiredTxFee(cryptoProvider.network.chainConfig))

  let seeds = {
    randomInputSeed,
    randomChangeSeed,
  }

  generateNewSeeds()

  const blockchainExplorer = ShelleyBlockchainExplorer(config)

  const accountIndex = 0

  const myAddresses = MyAddresses({
    accountIndex,
    cryptoProvider,
    gapLimit: config.ADALITE_GAP_LIMIT,
    blockchainExplorer,
  })

  function isHwWallet() {
    return cryptoProvider.isHwWallet()
  }

  function getHwWalletName() {
    return isHwWallet ? (cryptoProvider as any).getHwWalletName() : undefined
  }

  function submitTx(signedTx): Promise<any> {
    const {transaction, fragmentId} = signedTx
    return blockchainExplorer.submitTxRaw(fragmentId, transaction)
  }

  function getWalletSecretDef() {
    return {
      rootSecret: cryptoProvider.getWalletSecret(),
      derivationScheme: cryptoProvider.getDerivationScheme(),
    }
  }

  function prepareTxAux(plan) {
    return plan
  }

  async function signTxAux(txAux: any) {
    const signedTx = await cryptoProvider
      .signTx(txAux, myAddresses.fixedPathMapper())
      .catch((e) => {
        debugLog(e)
        throw NamedError('TransactionRejectedWhileSigning', e.message)
      })

    return signedTx
  }

  async function getMaxSendableAmount(address, hasDonation, donationAmount, donationType) {
    // TODO: why do we need hasDonation?
    const utxos = (await getUtxos()).filter(isUtxoProfitable)
    return _getMaxSendableAmount(utxos, address, hasDonation, donationAmount, donationType)
  }

  async function getMaxDonationAmount(address, sendAmount: Lovelace) {
    const utxos = (await getUtxos()).filter(isUtxoProfitable)
    return _getMaxDonationAmount(utxos, address, sendAmount)
  }

  async function getMaxNonStakingAmount(address) {
    const utxos = (await getUtxos()).filter(({address}) => !isBase(address))
    return _getMaxSendableAmount(utxos, address, false, 0, false)
  }

  type utxoArgs = {
    address?: string
    donationAmount?: Lovelace
    coins?: Lovelace
    poolHash?: string
    stakingKeyRegistered?: boolean
    txType?: string
  }

  const utxoTxPlanner = async (args: utxoArgs, accountAddress: string) => {
    const {address, coins, donationAmount, poolHash, stakingKeyRegistered, txType} = args
    const changeAddress = await getChangeAddress()
    const availableUtxos = await getUtxos()
    const nonStakingUtxos = availableUtxos.filter(({address}) => !isBase(address))
    const baseAddressUtxos = availableUtxos.filter(({address}) => isBase(address))
    const randomGenerator = PseudoRandom(seeds.randomInputSeed)
    // we shuffle non-staking utxos separately since we want them to be spend first
    const shuffledUtxos =
      txType === 'convert'
        ? shuffleArray(nonStakingUtxos, randomGenerator)
        : [
          ...shuffleArray(nonStakingUtxos, randomGenerator),
          ...shuffleArray(baseAddressUtxos, randomGenerator),
        ]
    const plan = selectMinimalTxPlan(
      shuffledUtxos,
      address,
      coins,
      donationAmount,
      changeAddress,
      accountAddress,
      poolHash,
      stakingKeyRegistered
    )
    return plan
  }

  type accountArgs = {
    address: string
    coins: Lovelace
    accountBalance: Lovelace
    counter: number
    txType: string
  }

  // const accountTxPlanner = (args: accountArgs, accountAddress: string) => {
  //   const {address, coins, accountBalance, counter} = args
  //   const plan = computeAccountTxPlan(
  //     cryptoProvider.network.chainConfig,
  //     coins,
  //     address,
  //     accountAddress,
  //     counter,
  //     accountBalance
  //   )
  //   return plan
  // }

  async function getTxPlan(args: utxoArgs | accountArgs) {
    const accountAddress = await myAddresses.accountAddrManager._deriveAddress(accountIndex)
    const txPlanners = {
      sendAda: utxoTxPlanner,
      convert: utxoTxPlanner,
      delegate: utxoTxPlanner,
      // redeem: accountTxPlanner,
    }
    return await txPlanners[args.txType](args, accountAddress)
  }

  async function getPoolInfo(url) {
    const poolInfo = await blockchainExplorer.getPoolInfo(url).catch(() => {
      return {}
    })
    return poolInfo
  }

  async function getWalletInfo() {
    const {stakingBalance, nonStakingBalance, balance} = await getBalance()
    const shelleyAccountInfo = await getAccountInfo()
    const visibleAddresses = await getVisibleAddresses()
    const transactionHistory = await getHistory()
    // getDelegationHistory
    // getWithdrawalHistory
    return {
      balance,
      shelleyBalances: {
        nonStakingBalance,
        stakingBalance: stakingBalance + shelleyAccountInfo.value,
        rewardsAccountBalance: shelleyAccountInfo.value,
      },
      shelleyAccountInfo,
      transactionHistory,
      visibleAddresses,
    }
  }

  async function getBalance() {
    const {legacy, base} = await myAddresses.discoverAllAddresses()
    const nonStakingBalance = await blockchainExplorer.getBalance(legacy)
    const stakingBalance = await blockchainExplorer.getBalance(base)
    return {
      stakingBalance,
      nonStakingBalance,
      balance: nonStakingBalance + stakingBalance,
    }
  }

  async function getHistory(): Promise<any> {
    // TODO: refactor to getTxHistory? or add delegation history or rewards history
    const {legacy, base, account} = await myAddresses.discoverAllAddresses()
    return blockchainExplorer.getTxHistory([...base, ...legacy, account])
  }

  async function getAccountInfo() {
    const accountPubkeyHex = await stakeAccountPubkeyHex(cryptoProvider, accountIndex)
    const accountInfo = await blockchainExplorer.getAccountInfo(accountPubkeyHex)
    const poolInfo = await getPoolInfo(accountInfo.delegation.url)
    return {
      ...accountInfo,
      delegation: {
        ...accountInfo.delegation,
        ...poolInfo,
      },
      value: 0,
    }
  }

  function getValidStakepools(): Promise<any> {
    return blockchainExplorer.getValidStakepools()
  }

  async function fetchTxInfo(txHash) {
    return await blockchainExplorer.fetchTxInfo(txHash)
  }

  function getChangeAddress() {
    return myAddresses.getChangeAddress(seeds.randomChangeSeed)
  }

  async function getUtxos(): Promise<Array<any>> {
    const {legacy, base} = await myAddresses.discoverAllAddresses()
    const baseUtxos = await blockchainExplorer.fetchUnspentTxOutputs(base)
    const nonStakingUtxos = await blockchainExplorer.fetchUnspentTxOutputs(legacy)
    return [...nonStakingUtxos, ...baseUtxos]
  }

  async function getVisibleAddresses() {
    const base = await myAddresses.baseExtAddrManager.discoverAddressesWithMeta()
    return base
  }

  function verifyAddress(addr: string) {
    throw NamedError('UnsupportedOperationError', 'unsupported operation: verifyAddress')
  }

  function generateNewSeeds() {
    seeds = {
      randomInputSeed: randomInputSeed || Math.floor(Math.random() * MAX_INT32),
      randomChangeSeed: randomChangeSeed || Math.floor(Math.random() * MAX_INT32),
    }
  }

  return {
    isHwWallet,
    getHwWalletName,
    getWalletSecretDef,
    submitTx,
    signTxAux,
    getBalance,
    getChangeAddress,
    getMaxSendableAmount,
    getMaxDonationAmount,
    getMaxNonStakingAmount,
    getTxPlan,
    getHistory,
    getVisibleAddresses,
    prepareTxAux,
    verifyAddress,
    fetchTxInfo,
    generateNewSeeds,
    getAccountInfo,
    getValidStakepools,
    getWalletInfo,
    getPoolInfo,
  }
}

export {ShelleyWallet}

require("dotenv").config();
const Web3 = require("web3");
const { ChainId, Token, Fetcher, TokenAmount } = require("@uniswap/sdk"); // importing uniswap sdk
const abis = require("./abis"); // importing the abi of kyber
const { mainnet: addresses } = require("./addresses"); // import the address of kyber contract
const Flashloan = require('./build/contracts/Flashloan.json');

const _web3 = new Web3(
  new Web3.providers.WebsocketProvider(process.env.INFURA_URL)
);
const { address: admin } = _web3.eth.accounts.wallet.add(process.env.PRIVATE_KEY)
console.log("Connected .......");

const kyber = new _web3.eth.Contract( //  Pull kyber prices
  abis.kyber.kyberNetworkProxy,
  addresses.kyber.kyberNetworkProxy
);

// const AMOUNT_ETH = 100; // quantity of ethers
// const RECENT_ETH_PRICE = 230;
// const AMOUNT_ETH_WEI = _web3.utils.toWei(AMOUNT_ETH.toString());
// const AMOUNT_DAI_WEI = _web3.utils.toWei(
//   (AMOUNT_ETH * RECENT_ETH_PRICE).toString()
// );
/**
 * Correction
 */
const ONE_WEI = _web3.utils.toBN(_web3.utils.toWei('1'));
const AMOUNT_DAI_WEI =_web3.utils.toBN(_web3.utils.toWei('20000'));

const DIRECTION = {
  KYBER_TO_UNISWAP: 0,
  UNISWAP_TO_KYBER: 1
};

const init = async () => {
  const networkId = await _web3.eth.net.getId();     // Getting Id from mainnet

  /**
   * Passing the flashloan abi file to an object
   */
  const flashloan = new _web3.eth.Contract(
    Flashloan.abi,
    Flashloan.networks[networkId].address
  );
  /**
   * Correction
   * New function for ETH price is added
   */
  let ethPrice;
  const updateEthPrice = async () => {
    const results = await kyber
      .methods
      .getExpectedRate(
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        addresses.tokens.dai,
        1
      )
      .call();
      ethPrice = _web3.utils.toBN('1').mul(_web3.utils.toBN(results.expectedRate)).div(ONE_WEI);
  }
  await updateEthPrice();
  setInterval(updateEthPrice, 15000);

  

  _web3.eth // listening to the new block of blockchain
    .subscribe("newBlockHeaders")
    .on("data", async (block) => {
      console.log(`\n\n\n\nNew block received. Block # ${block.number}`);
      // console.log(`\n\n\n\nNew block received. Block # ${JSON.stringify(block)}`);
      const [dai, weth] = await Promise.all(
        [addresses.tokens.dai, addresses.tokens.weth].map((tokenAddress) =>
          Fetcher.fetchTokenData(ChainId.MAINNET, tokenAddress)
        )
      );
    
      const daiWeth = await Fetcher.fetchPairData(dai, weth);

      /**
       * calling the functions from kyber contract
       */
      const kyberResults = await Promise.all([
        kyber.methods // dai to ether
          .getExpectedRate(
            addresses.tokens.dai, // address of token which is to convert
            "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", // address of token which is converted(address of ether)
            AMOUNT_DAI_WEI
          )
          .call(),
        kyber.methods // ether to dai
          .getExpectedRate(
            "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", // address of token which is to convert(address of ether)
            addresses.tokens.dai,
            AMOUNT_ETH_WEI
          )
          .call(),
      ]);
      // console.log("This is kyber Object\n", kyberResults);

      /**
       * Normalizing the kyber rates
       */
      const kyberRates = {
        buy: parseFloat(1 / (kyberResults[0].expectedRate / 10 ** 18)),
        sell: parseFloat(kyberResults[1].expectedRate / 10 ** 18),
      };
      console.log("kyber ETH/DAI\n", kyberRates);

      /**
       * Uniswap
       * Fetching the rates from uniswap exchange
       */
      const uniswapResults = await Promise.all([
        daiWeth.getOutputAmount(new TokenAmount(dai, AMOUNT_DAI_WEI)),
        daiWeth.getOutputAmount(new TokenAmount(weth, AMOUNT_ETH_WEI)),
      ]);
      // console.log("UNISWAP RESULTS", uniswapResults);

      const uniswapRates = {
        buy: parseFloat(
          AMOUNT_DAI_WEI / (uniswapResults[0][0].toExact() * 10 ** 18)
        ),
        sell: parseFloat(uniswapResults[1][0].toExact() / AMOUNT_ETH),
      };
      console.log("Uniswap ETH/DAI\n", uniswapRates);

      /**
       *  Finding the transaction cost 
       */
      const [tx1, tx2] = Object.keys(DIRECTION).map(direction => flashloan.methods.initiateFlashloan(
        addresses.dydx.solo,
        addresses.tokens.dai,
        AMOUNT_DAI_WEI,
        DIRECTION[direction]
      ));

      /**
       *  Calculating the Gas Price
       */
      const [gasPrice, gasCost1, gasCost2] = await Promise.all([
        _web3.eth.getGasPrice(), // calculating the gas price
        tx1.estimateGas({from: admin}),
        tx2.estimateGas({from: admin})
      ]);

      const txCost1 = parseInt(gasCost1 ) * parseInt(gasPrice);
      const txCost2 = parseInt(gasCost2 ) * parseInt(gasPrice);

      const currentEthPrice = (uniswapRates.buy + uniswapRates.sell) / 2;

      /**
       * profit = selling on uniswap and buying on kyber
       */
      const profit1 =
        parseInt(AMOUNT_ETH_WEI / 10 ** 18) *
          (uniswapRates.sell - kyberRates.buy) -
        (txCost1 / 10 ** 18) * currentEthPrice;
      // const profit1 =(parseInt((AMOUNT_ETH_WEI) )) * (uniswapRates.sell - kyberRates.buy) - (txCost ) * currentEthPrice;

      /**
       * profit = selling on kyber and buying in uniswap
       */
      const profit2 =
        parseInt(AMOUNT_ETH_WEI / 10 ** 18) *
          (kyberRates.sell - uniswapRates.buy) -
        (txCost2 / 10 ** 18) * currentEthPrice;
      // const profit2 =(parseInt((AMOUNT_ETH_WEI) )) * (kyberRates.sell - uniswapRates.buy) - (txCost ) * currentEthPrice;

      // console.log(`Profit1 = ${uniswapRates.sell - kyberRates.buy}`);
      // console.log(`Profit2 = ${kyberRates.sell - uniswapRates.buy}`);
      // console.log(`AMOUNT_ETH_WEI : ${parseInt(AMOUNT_ETH_WEI / 10 ** 18)}`);
      // console.log(`AMOUNT_DAI_WEI : ${parseInt(AMOUNT_ETH_WEI / 10 ** 18)}`);
      // console.log(`Transaction Cost: ${(txCost / 10 ** 18) * currentEthPrice}`);
 
      /**
       * Arbitrage Opportunity
       */
      if(profit1 > 0){
        console.log('Arbitrage opportunity found!');
        console.log(`Buy ETH on kyber at ${kyberRates.buy} dai`);
        console.log(`Sell ETH on Uniswap at ${uniswapRates.sell} dai`);
        console.log(`Expected profit: ${profit1} dai`);

        /**
         * Sending the transaction
         */
        const data = tx1.encodeABI();
        const txData = {
          from: admin,
          to: flashloan.options.address,
          data,
          gas: gasCost1,
          gasPrice
        };
        const receipt = await _web3.eth.sendTransaction(txData);
        console.log(`Transaction hash: ${receipt.transactionHash}`);
      } else if(profit2 > 0) {
        console.log('Arbitrage opportunity found!');
        console.log(`Buy ETH on Uniswap at ${uniswapRates.buy} dai`);
        console.log(`Sell ETH on Kyber at ${Kyber.sell} dai`);
        console.log(`Expected profit: ${profit2} dai`);
        const data = tx2.encodeABI();
        const txData = {
          from: admin,
          to: flashloan.options.address,
          data,
          gas: gasCost2,
          gasPrice
        };
        const receipt = await _web3.eth.sendTransaction(txData);
        console.log(`Transaction hash: ${receipt.transactionHash}`);
      } else {
        console.log("Sorry!!! Arbitrage Opportunity NOT FOUND ");
      }
    })
    .on("error", (error) => {
      console.log(error);
    });
};
init();

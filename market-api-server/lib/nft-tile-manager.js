
 
  /*

    Packet status:
    active - normal, works
    suspended - invalid token balance or approval (recoverable)
    expired - expired
    burned - sig has burned 


  */

    import BigNumber from 'bignumber.js' 

import Web3Helper from './web3-helper.js'
import BidPacketUtils from '../../src/js/bidpacket-utils.js'

import FileHelper from './file-helper.js'
import APIHelper from './api-helper.js'
import AppHelper from './app-helper.js'
 
export default class NFTTileManager  {

    constructor(web3, mongoInterface, vibegraphInterface, serverConfig){
        this.mongoInterface = mongoInterface;
        this.vibegraphInterface = vibegraphInterface;
        this.web3 = web3;
        this.serverConfig = serverConfig


        this.pollMarketOrders = true
        this.pollERC721Balances = true

        this.init() 

        
    }

    async init(){
        this.chainId =  this.serverConfig.chainId //await Web3Helper.getNetworkId(this.web3);
        await this.updateBlockNumber()
       

        setInterval(this.updateBlockNumber.bind(this),60*1000)

 
        this.startPolling()
    }

    async startPolling(){
 
 
          this.pollNextERC721Balance() 
      
          this.pollNextMarketOrder()
      

     
    }

    async updateBlockNumber(){

      try{ 
        this.blockNumber = await Web3Helper.getBlockNumber(this.web3);
      }catch(e){
          console.error(e)
      }

      if(this.blockNumber){
        await this.mongoInterface.serverDataModel.findOneAndUpdate({ }, {latestBlockNumber: this.blockNumber}, {upsert:true})
      }
     

  }


    async pollNextMarketOrder( ){
        
      
        const STALE_TIME = 360  * 1000;

        let nextMarketOrder = await this.mongoInterface.marketOrdersModel.findOne({lastPolledAt: {$not: {$gte: (Date.now() - STALE_TIME) }}  })

        
        if(nextMarketOrder){ 
          //console.log('pollNextMarketOrder',nextMarketOrder)

          
          await this.updateMarketOrderStatus(nextMarketOrder)
          await this.updateNftTilesFromMarketOrder(nextMarketOrder)
          
          await this.mongoInterface.marketOrdersModel.updateOne({_id: nextMarketOrder._id}, {lastPolledAt: Date.now()})


          setTimeout( this.pollNextMarketOrder.bind(this), 10)

        }else{
          //none found 
          //return

          setTimeout( this.pollNextMarketOrder.bind(this), 200)
        }

        

    }


    async pollNextERC721Balance( ){
        
     

      const STALE_TIME = 360*1000;

      let beforeTime = (Date.now() - STALE_TIME)

      let nextERC721Balance = await this.vibegraphInterface.erc721BalancesModel.findOne( {  tokenIds:{$not:  {$size:0}}, lastPolledAt:  {$not: {$gte: beforeTime }} })
      
       
        
      if(nextERC721Balance){ 

         
        await this.updateNftTilesFromERC721Balance(nextERC721Balance)
        
         await this.vibegraphInterface.erc721BalancesModel.updateOne({_id: nextERC721Balance._id}, {lastPolledAt: Date.now()})


         setTimeout( this.pollNextERC721Balance.bind(this), 10)

      }else{
        

        setTimeout( this.pollNextERC721Balance.bind(this), 200)
      }
 

  }


  async updateNftTilesFromERC721Balance(erc721Balance){
      
    let collectionName = AppHelper.contractAddressToCollectionName(erc721Balance.contractAddress)

    if(!collectionName){ 
      return
    }

    let ownerAddress = AppHelper.toChecksumAddress(erc721Balance.accountAddress)
    let ownedTokenIds = erc721Balance.tokenIds


    for(let tokenId of ownedTokenIds){

      let matchingNFTTile = await this.mongoInterface.cachedNFTTileModel.findOne({collectionName: collectionName , tokenId: tokenId })
     
       if(matchingNFTTile && ownerAddress != AppHelper.toChecksumAddress(matchingNFTTile.ownerPublicAddress)){
        let tileUpdate = await this.mongoInterface.cachedNFTTileModel.updateOne({_id: matchingNFTTile._id}, {ownerPublicAddress: ownerAddress})
        console.log('tileUpdate',tileUpdate)
      }
    } 

  }

    async updateMarketOrderStatus(marketOrder){

      let newMarketOrderStatus = 'valid'
      let collectionName = AppHelper.contractAddressToCollectionName(marketOrder.nftContractAddress)
      let orderCreator = AppHelper.toChecksumAddress(marketOrder.orderCreator)
      let currentBlockNumber = this.blockNumber 

      if(!collectionName){ 
        return
      }

      if(!currentBlockNumber){
        console.log('WARN: no block number to update market order status')
        return
      }

      //find matching nft, make sure the owner is equal to this market order owner 
      //if not , it is an invalid order to make it as such 
      let matchingNFTTile = await this.mongoInterface.cachedNFTTileModel.findOne({collectionName: collectionName , tokenId: marketOrder.nftTokenId })
      

      //if the order would revert in solidity we mark is as not valid 
      if(marketOrder.isSellOrder && matchingNFTTile.ownerPublicAddress && orderCreator != AppHelper.toChecksumAddress(matchingNFTTile.ownerPublicAddress)   ){
        newMarketOrderStatus = 'ownerAddressMismatched'
      }

      if(marketOrder.expires < currentBlockNumber){
        newMarketOrderStatus = 'orderExpired'
      }
      
      let matchingBurnedNonce = await this.vibegraphInterface.burnedNoncesModel.findOne({nonce: marketOrder.nonce})
      
      if(matchingBurnedNonce){       
        newMarketOrderStatus = 'nonceBurned'
      }


      await this.mongoInterface.marketOrdersModel.updateOne({_id: marketOrder._id}, {status: newMarketOrderStatus})
    }

  
    async updateNftTilesFromMarketOrder(marketOrder){

      // find matching nft tile, update its buyout if it is lower and if this is valid 
      
      //make sure currency token address is weth ?? --

     // let orderCreator = AppHelper.toChecksumAddress(marketOrder.orderCreator)
      let orderBuyoutPriceWei = marketOrder.currencyTokenAmount
      let orderCollectionName = AppHelper.contractAddressToCollectionName(marketOrder.nftContractAddress)

      if(!orderCollectionName){ 
        return
      }

      let matchingNFTTile = await this.mongoInterface.cachedNFTTileModel.findOne({collectionName: orderCollectionName , tokenId: marketOrder.nftTokenId })


      if(marketOrder.status == 'valid'){
        
        if(marketOrder.isSellOrder){
          if(matchingNFTTile && (!matchingNFTTile.buyoutPriceSort || !matchingNFTTile.lowestBuyoutPriceWei || !matchingNFTTile.buyoutPriceFromOrderId || matchingNFTTile.lowestBuyoutPriceWei > orderBuyoutPriceWei )){
            await this.mongoInterface.cachedNFTTileModel.updateOne({_id: matchingNFTTile._id}, {buyoutPriceSort: -1*orderBuyoutPriceWei , lowestBuyoutPriceWei: orderBuyoutPriceWei, buyoutPriceFromOrderId: AppHelper.mongoIdToNumber(marketOrder._id) })
          }
        }
        

      }else{ 
          
          
      
        if(matchingNFTTile.buyoutPriceFromOrderId && AppHelper.mongoIdToNumber(marketOrder._id) == matchingNFTTile.buyoutPriceFromOrderId){
          

          

             await this.mongoInterface.cachedNFTTileModel.findOneAndUpdate({_id: matchingNFTTile._id},   {buyoutPriceSort: null, lowestBuyoutPriceWei: null, buyoutPriceFromOrderId:null} )
          
             

        }

      

      }



    }



   
    
  

}
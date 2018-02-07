const murmur = require("murmurhash-js").murmur2;
const uuid = require("./uuid.js");
const Cache = require("./cache.js");

module.exports = exports = function SeamlessServer(db,buffer){

  var buffer = buffer || Cache();
  var clients = {};

  function _hash(q){
    if (typeof q === "object") {
      try {
        q = JSON.stringify(q);
      }
      catch (err) {
        throw err;
      }
    }
    if (typeof q === "string") return murmur(q||"");
    else throw new TypeError("argument is not convertible to string");
  }

  function wrapA(value){
    if (Array.isArray(value)){
      return value;
    }
    else {
      return [value];
    }
  }

  function unwrapExcessiveA(arr){
    if (Array.isArray(arr) && (arr.length === 1)) return arr[0];
    else return arr;
  }

  function unwrapFirstFromA(arr){
    if (Array.isArray(arr) || (arr[0] != undefined)){
      return arr[0];
    }
    else {
      return arr;
    }
  }

  function getDocsFrom(data){
    var d = wrapA(data).filter(function(d){return !!(d && (d._id || d._doc))})
      .map(function(d){ return d._doc || d });
    d.forEach(function(doc){doc._id = doc._id.toString()});
    return d;
  }

  function CacheData(reqid){
    return function (docs){
      try {
        buffer.set(reqid,"data",JSON.stringify(docs));
      }
      catch(error){
        console.error(error);
      }
      finally{
        return docs
      }
    }
  }

  function CacheQuery(reqid,query){
    if (typeof query === "object") query = JSON.stringify(query);
    return buffer.set(reqid,"query",query);
  }

  function RespondTo(responses,reqid){
    if (responses.send) responses = wrapA(responses);
    else if (typeof responses === "object") {
      responses = Object.values(responses);
    }
    return function(docs){
      responses.forEach(function(r){
        if (r && r.send){
          r.send(docs);
          if (!r.isWebsocket){
            deregisterClient(reqid,r.id);
          }
        }
      });
      return docs;
    };
  }

  function HandleErrTo(responses,reqid) {
    if (responses.send) responses = wrapA(responses);
    else if (typeof responses === "object") {
      responses = Object.values(responses);
    }
    return function(err){
      responses.forEach(function(r){
        if (r && r.status) {
          r.status(500).send('Error querying: ' + err.toString());
        }
        else r.close(500, 'Error querying: ' + err.toString());
        deregisterClient(reqid,r.id);
      });
    };
  }

  function registerClient(rid, peer) {
    if (!clients[rid]) clients[rid] = {};
    var id = peer.id = uuid();
    clients[rid][id] = peer;
    return id;
  }

  function deregisterClient(rid, peerid) {
    if (clients[rid]){
      if (clients[rid][peerid]){
        delete clients[rid][peerid];
      }
    }
  }

  function notifyRegisteredClients(collection,reqid){
    var Collection = db.collection(collection);
    if (clients[reqid].length) {
      return buffer.get(reqid,"query") //get a query string for reqid
      .then(function(q){
        if (q) { // if there is a query cached for this reqid - perform it and
          if (typeof q === "string") q = JSON.parse(q);
          return Collection.find(q).toArray()
          .then(getDocsFrom)
          .then(RespondTo(clients[reqid],reqid),HandleErrTo(clients[reqid],reqid)) // respond to all registered clients of this reqid
          .then(CacheData(reqid)) // Cache responses
          .catch(console.error);
        }
      })
      .catch(console.error);
    }
    else return Promise.resolve();
  };

  function getData(collection,rid,query,response){
    var Collection = db.collection(collection);
    return buffer.get(rid,"data")
      .then(function(data){
        if (data !== undefined){
          return Promise.resolve(data);
        }
        else return Promise.reject();
      })
      .then(RespondTo(response,rid))
      .catch(function(){
        return Collection.find(query).toArray()
          .then(getDocsFrom)
          .then(RespondTo(response,rid),HandleErrTo(response, rid))
          .then(CacheData(rid))
          .then(function(){
            CacheQuery(rid,query);
          })
          .catch(console.error);
      });
  }

  function pollData(rid,query,response){
    response.status(200);
    return CacheQuery(rid,query)
    .then(function(){
      var id = registerClient(rid,response);
      return new Promise(function(resolve,reject){
        setTimeout(function(){
          if (!response.finished){
            response.end();
          }
          deregisterClient(rid,id);
          resolve();
        },29000);
      }).catch(console.error);
    })
    .catch(console.error);
  }

  function postData(collection,reqid,query,body,response){
    body = wrapA(body);
    var docids;
    var Collection = db.collection(collection);
    if (response) registerClient(reqid,response);
    return Collection.bulkWrite(body.map(function(e) { // updates and inserts
      if (e._id) {
        return {
          updateOne: {
            filter: {
              _id: e._id
            },
            update: {$set: e},
            upsert: true
          }
        };
      }
      else {
        return {
          insertOne: {
            document: e
          }
        }
      }
    }))
    .then(function(bwres) { // remove those not mentioned
      docids = body
        .map(function(e){return e._id})
        .concat(
          Object.values(bwres.insertedIds)
          .map(function(e){
            if (typeof e === "string"){
              return e
            }
            else return e.toString();
          })
        )
        .filter(function(e){return e !== undefined});
        var rmquery = Object.assign(query);
        if (rmquery._id) {
          if (typeof rmquery._id !== "object"){
            rmquery._id = {$eq: rmquery._id}
          }
        }
        else rmquery._id = {};
        rmquery._id["$nin"] = docids;
      return Collection.deleteMany(rmquery)
        .then(function(){

          //Collection.notifyRegisteredClients(docids); !!!!

        });
    })
    .catch(console.error);
  }

  this.registerClient = registerClient;
  this.deregisterClient = deregisterClient;
  this.notifyRegisteredClients = notifyRegisteredClients;
  this.getData = getData;
  this.pollData = pollData;
  this.postData = postData;

  // HTTP endpoint middleware factory
  this.HTTPEndpointFor = function (collection){
    return function(req,res,next){
      var reqid = _hash(req.baseUrl+req.path);
      var query = req.params;
      res.isWebsocket = false;
      res.type('json');
      switch (req.method){
        case "GET":
          if (req.query.nopoll) {
            return getData(collection,reqid,query,res);
          }
          else {
            return pollData(reqid,query,res);
          }
        case "POST":
          return postData(collection,reqid,query,req.body,res);
        default:
          return next();
      }
    };
  };

  // Web Socket endpoint middleware factory
  this.WSEndpointFor = function(collection){
    return function(ws,req){
      var reqid = _hash(req.baseUrl+req.path);
      var query = req.params;
      ws.isWebsocket = true;
      var wsid = registerClient(reqid,ws);
      ws.on('message',function(message,flags){
        if (!flags.binary){
          postData(collection,reqid,query,JSON.parse(message));
        }
      });
      ws.on('close',function(code,reason){
        deregisterClient(reqid,wsid);
      });
      ws.on('error',function(error){
        console.error(error);
        ws.close(500,error);
      });
      getData(collection,reqid,query,ws);
    };
  };

}

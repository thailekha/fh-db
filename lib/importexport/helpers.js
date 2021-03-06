var AdmZip = require('adm-zip'),
archiver = require('archiver'),
streamBuffers = require('stream-buffers'),
async = require('async'),
fs = require('fs'),
mongodb = require('mongodb'),
bson = require('./bson.js'),
csv = require('./csv.js'),
jason = require('./json.js'),
extensionRegex = /\.[0-9a-z]+$/i,
RETRY_COUNT = 2,
importHandler = {
  json : jason.importer,
  csv : csv.importer,
  bson : bson.importer
},
exportHandler = {
  json : jason.exporter,
  csv : csv.exporter,
  bson : bson.exporter
},
helpers = {},
logger;


helpers.zipExport = function(collections, format, cb){
  // convert collections to in-memory zip file and stream response
  if (!exportHandler.hasOwnProperty(format)){
    return cb('Unsupported format');
  }

  if (collections.length === 0){
    return cb("No collections supplied");
  }

  var zipContentBuffer = new streamBuffers.WritableStreamBuffer({});

  var zip = archiver.create('zip', {});
  zip.pipe(zipContentBuffer);

  zipContentBuffer.on('finish', function(){
    return cb(null, zipContentBuffer.getContents());
  });

  var converters = {};

  Object.keys(collections).forEach(function(collectionName){
    converters[collectionName + '.' + format] = function(cb){
      var collection = collections[collectionName];
      exportHandler[format](collection, cb);
    };
  });

  // iterate over every converter function, returning a CSV or JSON definition of the collection
  async.parallel(converters, function(err, res){
    if (err){
      return cb(err);
    }
    Object.keys(res).forEach(function(key){
      var filename = key,
      contents = new Buffer(res[key]);
      zip.append(contents, {name: filename});
    });
    zip.finalize();
  });
};

helpers.importFile = function(params, cb){
  if (!params.files || !params.files.toimport){
    return cb("No file sent to import!");
  }
  var filePath = params.files.toimport.path.toString(),
  extension = params.filename.match(extensionRegex),
  name = params.filename.replace(extensionRegex, ''),
  fileType;
  if (!extension || extension.length === 0){
    return cb('Your file has no extension');
  }
  extension = extension[0];
  fileType = extension.replace('.', '');

  // Pass off to the zip importer
  if (fileType === 'zip') {
      return _importZip(filePath, cb);
  }
  var file = fs.readFile(filePath, function(err, file){
    if (err){
      return cb("Error reading file");
    }
    if (!importHandler.hasOwnProperty(fileType)){
      return cb('Unsupported file type: .' + fileType);
    }
    importHandler[fileType](file, function(err, result){
      if (err){
        return cb(err);
      }
      var response = {};
      response[name] = result;
      return cb(null, response);
    });
  });
};

var _importZip = function(filePath, cb, retries){
    retries = retries || 0;
    var parsers = {},
    zip, zipEntries;
    try{
      zip = new AdmZip(filePath);
      zipEntries = zip.getEntries();
    }catch(err){
      if (retries <= RETRY_COUNT){
        logger.warn('Retrying ' + retries);
        return setTimeout(function(){
          return helpers.importZip(filePath, cb, ++retries);
        }, 1000);
      }else{
        logger.error(err);
        return cb('Error reading zip file!');
      }
    }

    if (!zipEntries || zipEntries.length ===0){
      return cb('No zip entries found');
    }
    for (var i=0; i<zipEntries.length; i++){
      var zipEntry = zipEntries[i];
      var name = zipEntry.entryName.replace(extensionRegex, ''),
      extension = zipEntry.entryName.match(extensionRegex),
      data = zipEntry.getData(),
      fileType;

      if (!extension || extension.length === 0){
        // Assume dotfile
        return;
      }
      extension = extension[0];
      fileType = extension.replace('.', '');

      if (_isDisallowedCollectionName(zipEntry.entryName)){
        var msg = 'Not importing, disallowed collection name ' + zipEntry.entryName;
        logger.info('Not importing, disallowed collection name ' + zipEntry.entryName)
        return cb(msg);
      }

      if (!importHandler.hasOwnProperty(fileType)){
        var msg = 'Not importing, unsupported file type: .' + fileType;
        logger.info(msg);
        return cb(msg);
      }

      parsers[name] = function(parserCallback){
        importHandler[fileType](data, parserCallback);
      };

    }

    async.parallel(parsers, function(err, dataToImport){
      if (err){
        return cb(err);
      }
      return cb(null, dataToImport);
    });
};

var _isDisallowedCollectionName = function(name){
  var isSystemIndexes = /^system\.indexes\.(json|csv|bson$)/,
  isSystemUsers = /^system\.users\.(json|csv|bson$)/,
  isExportMetadata = /.+\.metadata\.json$/;

  return isSystemIndexes.test(name) || isSystemUsers.test(name) || isExportMetadata.test(name);
};

module.exports = function(lgr){
  logger = lgr;
  return helpers;
}

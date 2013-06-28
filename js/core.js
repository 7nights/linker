(function(){
  'use strict';

  var fs  = require('fs'),
      net = require('net'),
      settings = require('./settings'),
      crypto = require('crypto');

  // Constant
  var SYNC_DIR_ROOT_PATH = "D:/Linker",
      PORT = 35481;

  var pingInfo = {
    id: -1,
    callback: null
  },
  downloadingInfo = {
    id: -1,
    path: "",
    writeStream: null
  },
  currentServer = 0;

  // response的回调
  var FileListResponsePromises = {},
      IPListResponsePromises = {};

  function NiceBuffer(buf){
    this.buf = buf || new Buffer(0);
    this.length = this.buf.length;
  }
  NiceBuffer.prototype = {
    concat: function(buf){
      this.buf = Buffer.concat([this.buf, buf]);
      this.length = this.buf.length;
    },
    toBuffer: function(){
      return this.buf;
    },
    slice: function(start, end){
      return this.buf.slice(start, end);
    },
    writeUInt32: function(uint32){
      var buffer = new Buffer(4);
      buffer.writeUInt32LE(uint32, 0);
      this.concat(buffer);
    },
    writeUInt8: function(uint8){
      this.concat(new Buffer([uint8]));
    },
    shift: function(length){
      var temp = this.buf.slice(0, length);
      this.buf = this.buf.slice(length);
      this.length = this.buf.length;
      return temp;
    }
  };
  /*
   * 比较一个字符串是否大于另一个字符串
   * @param  {String} str1 此字符串是否大于第二个字符串
   * @param  {String} str2 
   * @return {Boolean}     第一个字符串是否大于第二个字符串
   */
  function compareStr(str1, str2){
    var length2 = str2.length;
    for(var i = 0, length = str1.length; i < length; i++){
      if(i === length2){
        return true;
      }
      var code1 = str1.charCodeAt(i),
          code2 = str2.charCodeAt(i);
      if(code1 > code2){
        return true;
      } else if(code1 < code2){
        return false;
      }
    }
    return true;
  }

  function md5(data, encoding){
    var hash = crypto.createHash("md5");
    hash.update(data);
    return hash.digest(encoding);
  }

  function getRandomUid(){
    return parseInt(Math.random() * 10000) + "_" + Date.now();
  }

  function getRandomBytes(size){
    var buf = new Buffer(size);
    while(size){
      size--;
      buf[size] =  parseInt(Math.random() * 255);
    }
    return buf;
  }

  function getAllAddresses(){
    var list = require('os').networkInterfaces(),
        addres = [];
    for(var key in list){
      for(var i = list[key].length; i--;){
        var obj = list[key][i];
        obj.family === 'IPv4' && !obj.internal && (addres.push(obj.address));
      }
    }
    return addres;
  }

  function getFileList(path){
    var dtd = $.Deferred();
    fs.readdir(path, function(err, files){
      if(err !== null){
        return dtd.reject(err);
      }
      for(var i = files.length; i--;){
        var stat = fs.statSync(require('path').join(path, files[i]));
        files[i] = {
          name: files[i],
          isDir: stat.isDirectory(),
          mtime: stat.mtime.getTime(),
          size: stat.size
        };
      }
      dtd.resolve(files);
    });
    return dtd.promise();
  }

  function MessageHead(buf){
    if(!(buf instanceof Buffer)){
      this.buf = new Buffer(buf);
    } else {
      this.buf = buf || new Buffer(0);
    }
  }
  MessageHead.create = function(type, fromId, toId, dataLength, dataMD5, sharedSecret){
    if(typeof data === "string"){
      data = new Buffer(data);
    }
    var buf = new Buffer(9);
    buf.writeUInt8(type, 0);
    buf.writeUInt32LE(fromId, 1);
    buf.writeUInt32LE(toId, 5);

    var md5buf;
    if(dataLength === 0){
      md5buf = Buffer.concat([buf.slice(1, 9), sharedSecret]);
    } else {
      md5buf = Buffer.concat([buf.slice(1, 9), dataMD5, sharedSecret]);
    }
    md5buf = md5(md5buf);
    buf = Buffer.concat([buf, md5buf]);

    var helper = new Buffer(4);
    helper.writeUInt32LE(dataLength, 0);
    return new MessageHead(Buffer.concat([buf, helper]));
  };
  MessageHead.prototype = {
    getType: function(){
      return this.buf.readUInt8(0);
    },
    getFromId: function(){
      return this.buf.readUInt32LE(1);
    },
    getToId: function(){
      return this.buf.readUInt32LE(5);
    },
    getHash: function(){
      return this.buf.slice(9, 25);
    },
    getDataLength: function(){
      return this.buf.readUInt32LE(25);
    },
    toBuffer: function(){
      return this.buf;
    },
    verify: function(dataMD5){
      var helper = new Buffer(8);
      helper.writeUInt32LE(this.getFromId(), 0);
      helper.writeUInt32LE(this.getToId(), 4);
      if(this.getDataLength() === 0){
        return this.getHash().toString('hex') == md5(Buffer.concat([helper, settings.get('password')])).toString('hex');
      }
      return this.getHash().toString('hex') == md5(Buffer.concat([helper, dataMD5, settings.get('password')])).toString('hex');
    }
  };

  /**
   * 向一个socket连接写入一个包, 会自动增加fromId
   * @param  {net.Socket} skt  要准备写入的socket
   * @param  {Buffer} head 包头
   * @param  {Buffer} [body] 包正文 
   */
  function writePackage(skt, head, body){
    skt.fromId++;
    skt.lastWritePackage = {
      head: head,
      body: body
    }
    if(head instanceof MessageHead) head = head.toBuffer();
    skt.write(head);
    if(body){
      skt.write(body);
    }
  }
  function dropPackage(c){
    console.log("包被丢弃了...");
    // TODO: 需要考虑如果客户端在发送完包头的时候包被丢弃的情况
    // 如果此时还有正文段, 则有可能永远无法解析到正确的包头
    // 此时可以让在一个包被丢弃后的一段持续时间里, 服务器持续忽略client发来的信息
    // client和客户端每次写包的时候都设置一个超时时间, 如果应该得到返回响应的包没有得到响应, 则重发请求
    c.dataState = 2;
    c.dataBuffer = new NiceBuffer();
  }
  function handleHeader(c){
    var mh = c.lastMH = new MessageHead(c.dataBuffer.shift(29));
    console.log("header type: " + mh.getType());
    // 是否header可以直接处理, 没有正文段的情况
    if(mh.getDataLength() === 0){
      // 检查header是否合法
      if(!mh.verify() && mh.getFromId() === (c.fromId + 1)){
        // 丢弃当前包, 也可以采取断开连接的措施, 要求客户端重连
        return dropPackage(c);
      }
    }
    for(var i = 0, length = handleHeader.chains.length; i < length; i++){
      if(handleHeader.chains[i](c)) return;
    }
    // default
    console.log("cannot find a handler for type #" + mh.getType());
    dropPackage(c);
  }
  handleHeader.chains = [];
  handleHeader.addCommand = function(c){
    handleHeader.chains.push(c);
    return handleHeader;
  };

  handleHeader.addCommand(function handle_20(c){
    var mh = c.lastMH;
    if(mh.getType() !== 20) return false;
    console.log("handling FileList Request header");
    // FileList Request
    // set dataState to 2 to receive request path
    c.needed = mh.getDataLength();
    c.dataState = 3;
    return true;
  })
  .addCommand(function handle_21(c){
    // 处理接受到 FileList Response 的header
    var mh = c.lastMH;
    if(mh.getType() !== 21) return false;
    c.needed = mh.getDataLength();
    c.dataState = 3;
    return true;
  })
  .addCommand(function handle_3(c){
    // IP List Request
    var mh = c.lastMH;
    if(mh.getType() !== 3) return false;
    var addres = getAllAddresses(),
        body = new Buffer(addres.join('\n')),
        h = MessageHead.create(30, c.fromId, mh.getFromId(), body.length, md5(body), settings.get('password'));
    writePackage(c, h, body);
    c.dataState = 2;
    return true;
  })
  .addCommand(function handle_30(c){
    // IP List Response
    var mh = c.lastMH;
    if(mh.getType() !== 30) return false;

    c.dataState = 3;
    c.needed = mh.getDataLength();
    return true;
  })
  .addCommand(function handle_4(c){
    // Tentative Request
    var mh = c.lastMH;
    if(mh.getType() !== 4) return;
    var h = MessageHead.create(5, c.fromId, mh.getFromId(), 0, null, settings.get('password'));
    writePackage(c, h);
    c.dataState = 2;
    return true;
  })
  .addCommand(function handle_5(c){
    // Ping Response
    var mh = c.lastMH;
    var callback = pingInfo.callback,
        host = pingInfo.host,
        success;
    if(mh.getType() !== 5) return;
    if(pingInfo.id === mh.getToId()){
      success = true;
    } else if(pingInfo.id !== -1){
      success = false;
    }
    pingInfo.id = -1;
    pingInfo.callback = null;
    pingInfo.host = null;
    c.dataState = 2;
    if(typeof callback === "function"){
      console.log("callback");
      callback(host, success);
    }
    return true;
  })
  .addCommand(function handle_8(c){
    var mh = c.lastMH;
    if(mh.getType() !== 8) return;
    c.dataState = 3;
    c.needed = mh.getDataLength();
    return true;
  })
  .addCommand(function handle_9(c){
    var mh = c.lastMH;
    if(mh.getType() !== 9) return;
    // 在发送请求之前就应该建立好writeStream, 因此收到响应时writeStream已经可用
    if(mh.getToId() !== downloadingInfo.id) {
      dropPackage();
      return true;
    }
    c.dataState = 3;
    c.needed = mh.getDataLength();
    return true;
  });

  function handleBody(c, verify){
    var mh = c.lastMH,
        body = c.dataBuffer.slice(0, c.needed);
    // 验证包的有效性
    if(verify !== false && !mh.verify(md5(body))){
      console.log("invalid package", body.toString());
      console.log("data length: " + mh.getDataLength(), "body length: " + body.length);
      return dropPackage(c);
    }
    for(var i = 0, length = handleBody.chains.length; i < length; i++){
      if(handleBody.chains[i](c)) return;
    }
    // default
    dropPackage();
  }
  handleBody.chains = [];
  handleBody.addCommand = function(c){
    handleBody.chains.push(c);
    return handleBody;
  };

  handleBody.addCommand(function handle_20(c){
    // FileList Request
    var mh = c.lastMH;
    if(mh.getType() !== 20) return false;
    var body = c.dataBuffer.shift(c.needed);
    var path = require('path').join(SYNC_DIR_ROOT_PATH, body.toString('utf-8'));
    console.log("requested path: " + path);
    getFileList(path)
    .done(function(files){
      files = new Buffer(JSON.stringify(files));
      var h = MessageHead.create(21, c.fromId, mh.getFromId(), files.length, md5(files), settings.get('password'));
      writePackage(c, h, files);
      console.log("返回file list");
    })
    .fail(function(er){
      console.error(er);
      //return dropPackage(c);
    });
    return true;
  })
  .addCommand(function handle_21(c){
    // FileList Response
    var mh = c.lastMH;
    if(mh.getType() !== 21) return false;
    var body = c.dataBuffer.shift(c.needed);
    var dtd = FileListResponsePromises[mh.getToId()];
    try{
      var files = JSON.parse(body.toString('utf-8'));
      if(dtd){
        dtd.resolve(dtd.data_path || "", files);
      }
    } catch(e) {
      console.error(e);
       if(dtd){
        dtd.reject();
      }
    }
    return true;
  })
  .addCommand(function handle_30(c){
    // IP List Response
    var mh = c.lastMH;
    if(mh.getType() !== 30) return false;
    var body = c.dataBuffer.shift(c.needed);
    var dtd = IPListResponsePromises[mh.getToId()];
    if(dtd){
      dtd.resolve(body.toString('utf-8').split('\n'));
      dtd = null;
    }
    return true;
  })
  .addCommand(function handle_8(c){
    // Download Request
    var mh = c.lastMH;
    if(mh.getType() !== 8) return false;
    var body = c.dataBuffer.shift(c.needed);
    var file = require('path').join(SYNC_DIR_ROOT_PATH, body.toString('utf-8'));
    // TODO: 应该采用"油门"的方式读取和发送文件
    fs.readFile(file, function(err, data){
      if(err !== null) console.error(err);
      var md5buf = md5(data),
          h = MessageHead.create(9, c.fromId, mh.getFromId(), data.length, md5buf, settings.get('password'));
      writePackage(c, h, data);
    });
    return true;
  })
  .addCommand(function handle_9(c){
    // Download Response
    var mh = c.lastMH;
    if(mh.getType() !== 9) return false;

    // TODO:对于下载文件, 应该先保存在一个临时的地方, 通过md5验证后才真正转移到Linker的文件夹里
    // 这里就没有验证了
    if(downloadingInfo.id === mh.getToId()){
      if(c.dataBuffer.length <= c.needed){
        var buf = c.dataBuffer.shift(c.dataBuffer.length);
        c.needed -= buf.length;
        downloadingInfo.writeStream.write(buf);
      } else {
        var buf = c.dataBuffer.shift(c.needed);
        c.needed = 0;
        downloadingInfo.writeStream.write(buf);
      }
    }
    if(c.needed === 0){
      // 下载完成断开连接
      downloadingInfo.dtd.resolve(downloadingInfo.path);
      downloadingInfo.writeStream.end();
      downloadingInfo.writeStream = null;
      downloadingInfo.id = -1;
      downloadingInfo.path = "";
      downloadingInfo.dtd = null;
      cleanSocket(c);
    }
    return true;
  });

  function cleanSocket(c){
    c.end();
    c.destroy();
    if("serverNo" in c){
      LinkerClient.unlinkServerSocket(c.serverNo);
    }
    c = null;
  }

  var LinkerServer = (function(){

    var server = net.createServer(function(c){
      // 'connection' listener
      console.log(c.address(), "connection");
      c.uid = getRandomUid();
      c.fromId = 0;
      c.toId = 0;
      c.dataState = 0;
      var dateBuffer = new Buffer(4);
      dateBuffer.writeUInt32LE(parseInt(Date.now()/1000), 0);
      c.hmac = Buffer.concat([getRandomBytes(12), dateBuffer]);
      dateBuffer = null;
      c.dataBuffer = new NiceBuffer();
      c.on('data', function(data){
        c.dataBuffer.concat(data);
        if(c.dataState === 0){
          // 处于等待握手阶段 type = 0
          if(c.dataBuffer.length < 45) return;
          var mh = new MessageHead(c.dataBuffer.slice(0, 29));
          if(mh.getType() !== 0){
            cleanSocket(c);
            return;
          }
          var hmac = crypto.createHmac('md5', settings.get("password"));
          hmac.update(c.hmac);
          if(hmac.digest('hex') == c.dataBuffer.slice(29).toString('hex')){
            // 握手成功
            console.log("握手成功");
            c.dataState = 2;
            c.dataBuffer = new NiceBuffer();
            writePackage(c, MessageHead.create(0, c.fromId, mh.getFromId(), 0, null, settings.get("password")));
          } else {
            cleanSocket(c);
          }
        }
        if(c.dataState === 2){ // 就绪状态, 正在接收header
          console.log("正在接收header");
          if(c.dataBuffer.length < 29) return;
          console.log("header 接收完毕");
          // header 接收完毕
          //c.dataState = 2;
          handleHeader(c);
          while(c.dataBuffer.length >= 29 && c.dataState === 2) handleHeader();
        }
        if(c.dataState === 3){ // 处于接受正文的状态
          if(c.dataBuffer.length < c.needed) return;
          // 正文接收完毕
          console.log("正文接收完毕");
          handleBody(c);
          c.dataState = 2;
          while(c.dataBuffer.length >= 29 && c.dataState === 2) handleHeader();
        }
      });
      c.on('error', function(err){
        console.error(err);
      });
      // 发送HMAC
      c.write(c.hmac);

    });
    server.on('error', function(e){
      console.log(e);
    });
    
    return {
      start: function(){
        server.listen(PORT, function(){
          // 'listening' listener
          console.log('Linker Server started listening.');
        });
      }
    };
  })();

  var LinkerClient = (function(){
    var skts = [];
    var createConnection = function(host, port, callback, errorHandler){
      
      !port && (port = PORT);
      var s = net.createConnection(port, host, function(){
        console.log('connected to ' + host + ':' + port);
        s.dataState = 0;
        //s.isClient = true;
        s.toId = 0;
        s.fromId = 0;
        s.dataBuffer = new NiceBuffer();
        s.on('data', function(data){
          // 压入
          s.dataBuffer.concat(data);
          if(s.dataState === 0){
            // 等待握手
            if(s.dataBuffer.length < 16) return;
            // 足够的比特可以进行握手
            var hmac = crypto.createHmac('md5', settings.get('password'));
            hmac.update(s.dataBuffer.slice(0, 16));
            var dataHmaced = hmac.digest(),
                mh = MessageHead.create(0, s.fromId, 0, dataHmaced.length, md5(dataHmaced), settings.get('password'));
            writePackage(s, mh.toBuffer(), dataHmaced);
            s.dataState = 1;
            s.dataBuffer = new NiceBuffer();
          }
          if(s.dataState === 1){
            // 服务器返回握手答复
            if(s.dataBuffer.length < 29) return;
            // 头部可读取
            var mh = new MessageHead(s.dataBuffer.shift(29));
            if(mh.getType() !== 0) return cleanSocket(s);
            s.dataState = 2;
            console.log('handshake succeed.');
          }
          if(s.dataState === 2){
            if(s.dataBuffer.length < 29) return;
            console.log("header 接收完毕");
            // header 接收完毕
            //c.dataState = 2;
            handleHeader(s);
          }
          if(s.dataState === 3){
            if(s.lastMH.getType() === 9) {
              // 处于下载文件的状态, 每次收到data都会调用handleBody
              handleBody(s, false);
              return;
            }
            if(s.dataBuffer.length < s.needed) return;
            // 正文接收完毕
            console.log("正文接收完毕");
            handleBody(s);
            s.dataState = 2;
          }
        });
        if(typeof callback === "function") callback();
      });
      s.on('error', function(er){
        if(typeof errorHandler === "function"){
          errorHandler(er);
        }
      });
      skts.push(s);
      s.serverNo = skts.length - 1;
      return skts.length - 1;
    },
    requestFileList = function(sn, path){
      var dtd = $.Deferred();
      if(!skts[sn]){
        dtd.reject();
        return dtd.promise();
      }
      var fromId = skts[sn].fromId,
          h;

      if(path){
        dtd.data_path = path;
        path = new Buffer(path);
        h = MessageHead.create(20, fromId, 0, path.length, md5(path), settings.get('password'));
      } else {
        h = MessageHead.create(20, fromId, 0, 0, null, settings.get('password'));
      }
      FileListResponsePromises[fromId] = dtd;
      dtd.always(function(){
        delete FileListResponsePromises[fromId];
      });
      writePackage(skts[sn], h, path);
      return dtd.promise();
    },
    requestIPList = function(sn){
      var dtd = $.Deferred();
      if(!skts[sn]){
        dtd.reject();
        return dtd.promise();
      }
      var fromId = skts[sn].fromId,
          h = MessageHead.create(3, fromId, 0, 0, null, settings.get('password'));
      IPListResponsePromises[fromId] = dtd;
      dtd.always(function(){
        delete IPListResponsePromises[fromId];
      });
      writePackage(skts[sn], h);
      return dtd.promise();
    },
    ping = function(host, timeout, callback){
      if(pingInfo.id !== -1) {
        //alert("已经发起了ping");
        return false;
      }
      pingInfo.id = -2;
      pingInfo.host = host;
      pingInfo.callback = callback;
      var s = createConnection(host, null, function sendPing(){
        if(s.dataState > 1){
          pingInfo.id = s.fromId;
          var h = MessageHead.create(4, s.fromId, 0, 0, null, settings.get('password'));
          writePackage(s, h);
        } else {
          setTimeout(sendPing, 200);
        }
      });
      s = skts[s];
      s.on('error', function(err){});
      s.setTimeout(timeout, function(){
        if(pingInfo.id === -1) return;
        pingInfo.id = -1;
        pingInfo.host = null;
        pingInfo.callback = null;
        cleanSocket(s);
        typeof callback === "function" && callback(host, false);
      });
      setTimeout(function(){
        if(pingInfo.id === -1) return;
        pingInfo.id = -1;
        pingInfo.host = null;
        pingInfo.callback = null;
        cleanSocket(s);
        typeof callback === "function" && callback(host, false);
      }, timeout);
      return true;
    },
    download = function(addr, path){
      var dtd = $.Deferred();
      if(addr === null){
        addr = skts[currentServer].address().address;
      }
      var s = createConnection(addr, null, function _download(){
        if(s.dataState > 1){
          if(downloadingInfo.id !== -1) throw new Error("前一个downloading未解决");
          downloadingInfo.path = path;
          downloadingInfo.id = s.fromId;
          downloadingInfo.writeStream = fs.createWriteStream("D:/temp/" + path);
          downloadingInfo.dtd = dtd;
          var buf_path = new Buffer(path),
              h = MessageHead.create(8, s.fromId, 0, path.length, md5(path), settings.get('password'));
          writePackage(s, h, buf_path);
          console.log("发起download");
        } else {
          setTimeout(_download, 200);
        }
      });
      s = skts[s];
      return dtd.promise();
    };

    return {
      requestFileList: requestFileList,
      connect: createConnection,
      requestIPList: requestIPList,
      ping: ping,
      download: download,
      unlinkServerSocket: function(num){
        skts[num] = null;
      },
      getServerSocket: function(num){
        return skts[num];
      }
    };
  })();

  window.Linker = {
    getFileList: getFileList,
    Client: LinkerClient,
    Server: LinkerServer,
    getAllAddresses: getAllAddresses,
    getCurrentServerNo: function(){
      return currentServer;
    },
    setCurrentServerNo: function(val){
      currentServer = val;
    }
  };
})();
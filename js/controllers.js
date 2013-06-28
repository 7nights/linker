'use strict';

/* Controllers */

angular.module('myApp.controllers', []).
  controller('debug', ['$scope', function($scope) {
    var gui = require('nw.gui'),
        win = gui.Window.get();
    win.showDevTools();
    $scope.debug = "debug sout.";
    Linker.Server.start();
    $scope.connect = function(){
      Linker.Client.connect('127.0.0.1');
    };
    $scope.requestFileList = function(){
    };
    file_path.addEventListener('change', function(e){

      Linker.Client.requestFileList(0)
      .done(function(path, files){
        console.log("path: " + path, files);
      });

      Linker.Client.requestIPList(0)
      .then(getValidAddress)
      .done(function(addr){
        Linker.Client.download(addr, "test1.txt");
      })
      .fail(function(){
        // Linker.Client.download(null, path);
      });
    });
  }])
  .controller('BodyCtrl', ['$scope', function($scope){
    $scope.files = [];
    $scope.convertTime = function(time){
      return new Date(time).toLocaleString();
    };
    $scope.convertSize = function(size){
      size = "" + parseInt(size / 1024);
      
      var str = "",
          i = size.length - 1;
      while(i >= 0){
        if((size.length - i - 1) % 3 === 0 && i !== size.length - 1) str = "," + str;
        str = size[i] + str;
        i--;
      }
      return str + " KB";
    };
  }])
  .controller('NavCtrl', ['$scope', function($scope){
    Linker.Server.start();
    $scope.buttonClass = {};
    $scope.stateButton = "连接";
    var button = document.getElementById('connectHostSubmit'),
        input = document.getElementById('connectHost');
    $scope.refreshFileList = function(){
      var s = Linker.Client.getServerSocket(Linker.getCurrentServerNo());
      if(!s || s.dataState < 2) return alert("请先连接一个主机!");
      Linker.Client.requestFileList(0, "")
      .done(function(path, files){
        $scope.$parent.files = files;
        console.log(files);
        $scope.$parent.$digest();
        $scope.$digest();
      })
      .fail(function(){
        alert("连接已失效");
      });
    };
    $scope.connect = function(){
      if(!$scope.host) return alert("请输入要连接到的主机");
      var s = Linker.Client.connect($scope.host, null, function callback(){
        if(s.dataState > 1){
          $scope.stateButton = "已连接";
          $scope.buttonClass.success = true;
          $scope.$digest();

          // 连接之后获取根目录文件夹信息
          Linker.Client.requestFileList(temp, "")
          .done(function(path, files){
            console.log("path: " + path);
            $scope.$parent.files = files;
            console.log(files);
            $scope.$parent.$digest();
            $scope.$digest();
          })
          .fail(function(){
            alert("连接已失效");
          });

        } else {
          setTimeout(callback, 200);
        }
      }, function(er){
        if(er.code === "ECONNRESET"){
          Linker.Client.unlinkServerSocket(temp);
        }
        alert("连接失败!");
        $scope.$parent.files = [];
        $scope.$parent.$digest();
        $scope.stateButton = "连接";
        $scope.host = "";
        $scope.disabled = false;
        $scope.$digest();
      });
      var temp = s;
      Linker.setCurrentServerNo(s);
      s = Linker.Client.getServerSocket(s);
      $scope.disabled = true;
      $scope.stateButton = "正在连接...";
      //$scope.$digest();
    };
  }])
  .controller('StageCtrl', ['$scope', function($scope){
    function getValidAddress(list){
      var localList = Linker.getAllAddresses();
      var tempList1 = {},
          tempList2 = {},
          similarList = [],
          dtd = $.Deferred();
      for(var i = localList.length; i--;){
        // TODO: 事实上A,B,C类IP地址的网络段不同
        var key = localList[i].split('.')[0] + "." + localList[i].split('.')[1];
        tempList1[key] = true;
      }
      for(var i = list.length; i--;){
        // TODO: 事实上A,B,C类IP地址的网络段不同
        var key = list[i].split('.')[0] + "." + list[i].split('.')[1];
        if(!tempList2[key]){
          tempList2[key] = [];
        }
        tempList2[key].push(list[i]);
      }
      for(var key in tempList2){
        if(key in tempList1){
          similarList = similarList.concat(tempList2[key]);
        }
      }

      // 发起测试
      var index = 0;
      var doPing = Linker.Client.ping(similarList[index], 250, function callback(host, success){
        console.log("对" + host + "发起测试的回应是: " + success);
        if(!success){
          index++;
          if(index < similarList.length){
            
            doPing = Linker.Client.ping(similarList[index], 250, callback);
            console.log(doPing);
          } else {
            dtd.reject();
          }
        } else {
          dtd.resolve(similarList[index]);
        }
      });
      if(!doPing) alert("您下载得太快了请稍等一下!");

      return dtd.promise();
    }
    $scope.download = function(e){
      Linker.Client.requestIPList(0)
      .then(getValidAddress)
      .done(function(addr){
        Linker.Client.download(addr, e.file.name)
        .done(function(path){
          alert("已完成 " + path + "的下载!");
        });
      })
      .fail(function(){
        // Linker.Client.download(null, path);
      });
    };

    document.body.offsetHeight;
  }]);
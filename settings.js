(function(){
  'use strict';
  var settings = {
    password: new Buffer("default_password")
  };
  exports.get = function(key, _default){
    return settings[key] || _default;
  };
})();
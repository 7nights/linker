var net = require('net');
var c = net.createConnection(35481, '127.0.0.1', function(arg){
	console.log("arg: ", arg);
	c.on('data', function(data){
		console.log('received: ' + data.toString('hex'));
	});
});
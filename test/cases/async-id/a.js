define(function(require){
	var $ = require('jquery');
	var b = require('b');
	require.async('c', function(c){
		return c;
	});
})
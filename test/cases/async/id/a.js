define(function(require){
	var $ = require('jquery');
	var b = require('id/b');
	require.async('id/c', function(c){
		return c;
	});
})
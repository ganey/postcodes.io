"use strict";

var fs = require("fs");
var S = require("string");
var util = require("util");
var path = require("path");
var Pc = require("postcode");
var async = require("async");
var OSPoint = require("ospoint");
var Base = require("./index").Base;
var QueryStream = require("pg-query-stream");
var env = process.env.NODE_ENV || "development";
var defaults = require(path.join(__dirname, "../../config/config.js"))(env).defaults;

var postcodeSchema = {
	"id": "SERIAL PRIMARY KEY",
	"postcode" : "VARCHAR(10)",
	"pc_compact" : "VARCHAR(9)",
	"quality" : "INTEGER",
	"eastings" : "INTEGER",
	"northings" : "INTEGER",
	"country" : "VARCHAR(255)",
	"nhs_ha" : "VARCHAR(255)",
	"admin_county_id" : "VARCHAR(32)",
	"admin_district_id" : "VARCHAR(32)",
	"admin_ward_id" : "VARCHAR(32)",
	"longitude" : "DOUBLE PRECISION",
	"latitude" : "DOUBLE PRECISION",
	"location" : "GEOGRAPHY(Point, 4326)",
	"parliamentary_constituency" : "VARCHAR(255)",
	"european_electoral_region" : "VARCHAR(255)",
	"primary_care_trust" : "VARCHAR(255)", 
	"region" : "VARCHAR(255)", 
	"parish_id" : "VARCHAR(32)", 
	"lsoa" : "VARCHAR(255)", 
	"msoa" : "VARCHAR(255)",
	"nuts_id" : "VARCHAR(32)",
	"incode" : "VARCHAR(5)",
	"outcode" : "VARCHAR(5)",
	"ccg_id" : "VARCHAR(32)"
};

var indexes = [{
	unique: true,
	column: "postcode"
}, {
	unique: true,
	column: "pc_compact",
	opClass: "varchar_pattern_ops"
}, {
	type: "GIST",
	column: "location"
}, {
	column: "outcode"
}];

var relationships = [{
	table: "districts",
	key: "admin_district_id",
	foreignKey: "code"
}, {
	table: "parishes",
	key: "parish_id",
	foreignKey: "code"
}, {
	table: "counties",
	key: "admin_county_id",
	foreignKey: "code"
}, {
	table: "wards",
	key: "admin_ward_id",
	foreignKey: "code"
},{
	table: "ccgs",
	key: "ccg_id",
	foreignKey: "code"
},{
	table: "nuts",
	key: "nuts_id",
	foreignKey: "code"
}];

var toJoinString = function () {
	return relationships.map(function (r) {
		return ["LEFT OUTER JOIN", r.table, "ON", "postcodes." + r.key, 
						"=", r.table + "." + r.foreignKey].join(" ");
	}).join(" ");
};

var foreignColumns = [{
	field: "districts.name",
	as: "admin_district"
}, {
	field: "parishes.name",
	as: "parish"
}, {
	field: "counties.name",
	as: "admin_county"
}, {
	field: "wards.name",
	as: "admin_ward"
},{
	field: "ccgs.name",
	as: "ccg"
},{
	field: "nuts.name",
	as: "nuts"
},{
	field: "nuts.nuts_code",
	as: "nuts_code"
}];

var toColumnsString = function () {
	return foreignColumns.map(function(elem) {
		return [elem.field, "as", elem.as ].join(" ");
	}).join(",");
};

function Postcode () {
	this.idCache = {};
	Base.call(this, "postcodes", postcodeSchema, indexes);
}

util.inherits(Postcode, Base);

var findQuery = ["SELECT postcodes.*,",
								toColumnsString(),
								"FROM postcodes",
								toJoinString(),
								"WHERE pc_compact=$1"].join(" ");

Postcode.prototype.find = function (postcode, callback) {
	if (typeof postcode !== "string") {
		return callback(null, null);
	} 

	postcode = postcode.trim().toUpperCase();

	if (!new Pc(postcode).valid()) {
		return callback(null, null);
	}

	this._query(findQuery, [postcode.replace(/\s/g, "")], function(error, result) {
		if (error) return callback(error, null);
		if (result.rows.length === 0) {
			return callback(null, null);
		}
		callback(null, result.rows[0]);
	});
}

Postcode.prototype.loadPostcodeIds = function (type, callback) {
	var self = this;

	if (typeof type === 'function') {
		callback = type;
		type = "_all";
	}

	self._getClient(function (error, client, done) {
		var cleanUp = function (error, ids) {
			done();
			if (callback) {
				return callback(error, ids);
			} else {
				return null;
			}
		};
		if (error) return cleanUp(error);

		var params = [];
		var countQuery = "SELECT count(id) FROM postcodes";
		var idQuery = "SELECT id FROM postcodes";

		if (type !== "_all") {
			countQuery += " WHERE outcode = $1";
			idQuery += " WHERE outcode = $1";
			params.push(type.replace(/\s/g, "").toUpperCase());
		}

		client.query(countQuery, params, function (error, result) {
			if (error) return cleanUp(error);
			var i = 0;
			var count = result.rows[0].count;
			if (count === 0) return callback(null, null);
			var idStore = new Array(count);
			client.query(new QueryStream(idQuery, params))
				.on("end", function () {
					self.idCache[type] = idStore;
					cleanUp(null, idStore);
				})
				.on("error", cleanUp)
				.on("data", function (data) {
					idStore[i] = data.id;
					i++;
				});
		});
	});
};

Postcode.prototype.random = function (options, callback) {
	var self = this;

	if (typeof options === 'function') {
		callback = options;
		options = {};
	}

	var randomType = typeof options.outcode === 'string' && options.outcode.length ? options.outcode : "_all";
	var idCache = self.idCache[randomType];

	if (!idCache) {
		return self.loadPostcodeIds(randomType, function (error, ids) {
			if (error) return callback(error);
			return self.randomFromIds(ids, callback);
		});
	}

	return self.randomFromIds(idCache, callback);
};

var findByIdQuery = 
	["SELECT postcodes.*,",
	toColumnsString(),
	"FROM postcodes",
	toJoinString(),
	"WHERE id=$1"].join(" ");

// Use an in memory array of IDs to retrieve random postcode

Postcode.prototype.randomFromIds = function (ids, callback) {
	var length = ids.length;
	var randomId = ids[Math.floor(Math.random() * length)];
	this._query(findByIdQuery, [randomId], function (error, result) {
		if (error) return callback(error, null);
		if (result.rows.length === 0) {
			return callback(null, null);
		}
		callback(null, result.rows[0]);
	});
};

var searchRegexp = /\W/g;

var	searchQuery = ["SELECT postcodes.*,",
									toColumnsString(),
									"FROM postcodes",
									toJoinString(),
									"WHERE pc_compact ~ $1",
									"LIMIT $2"].join(" ");

Postcode.prototype.search = function (postcode, options, callback) {
	var DEFAULT_LIMIT = defaults.search.limit.DEFAULT;
	var MAX_LIMIT = defaults.search.limit.MAX;
	var limit;
	if (typeof options === 'function') {
		callback = options;
		limit = 10;
	} else {
		limit = parseInt(options.limit, 10);
		if (isNaN(limit)) limit = DEFAULT_LIMIT;
		if (limit > MAX_LIMIT) limit = MAX_LIMIT;
	}
	
	
	// Strip spaces and any regex special characters
	var re = "^" + postcode.toUpperCase().replace(searchRegexp, "") + ".*";
			
	this._query(searchQuery, [re, limit], function (error, result) {
		if (error) return callback(error, null);
		if (result.rows.length === 0) {
			return callback(null, null);
		}
		return callback(null, result.rows);
	});
}

var nearestPostcodeQuery =  ["SELECT postcodes.*,", 
	"ST_Distance(location, ST_GeographyFromText('POINT(' || $1 || ' ' || $2 || ')')) AS distance,", 
	toColumnsString(),
	"FROM postcodes",
	toJoinString(),
	"WHERE ST_DWithin(location, ST_GeographyFromText('POINT(' || $1 || ' ' || $2 || ')'), $3)", 
	"ORDER BY distance ASC, postcode ASC",
	"LIMIT $4"].join(" ");

Postcode.prototype.nearestPostcodes = function (params, callback) {
	var self = this;
	var DEFAULT_RADIUS = defaults.nearest.radius.DEFAULT;
	var MAX_RADIUS = defaults.nearest.radius.MAX;
	var DEFAULT_LIMIT = defaults.nearest.limit.DEFAULT;
	var MAX_LIMIT = defaults.nearest.limit.MAX;

	var limit = parseInt(params.limit, 10) || DEFAULT_LIMIT;
	if (limit > MAX_LIMIT) limit = MAX_LIMIT;

	var longitude = parseFloat(params.longitude);
	if (isNaN(longitude)) return callback(new Error("Invalid longitude"), null);

	var latitude = parseFloat(params.latitude);
	if (isNaN(latitude)) return callback(new Error("Invalid latitude"), null);

	var radius = parseFloat(params.radius) || DEFAULT_RADIUS;
	if (radius > MAX_RADIUS) radius = MAX_RADIUS;

	var handleResult = function (error, result) {
		if (error) return callback(error, null);
		if (result.rows.length === 0) {
			return callback(null, null);
		}
		return callback(null, result.rows);
	};

	// If a wideSearch query is requested, derive a suitable range which guarantees 
	// postcode results over a much wider area
	if (params.wideSearch || params.widesearch) {
		if (limit > DEFAULT_LIMIT) {
			limit = DEFAULT_LIMIT;
		}
		return self._deriveMaxRange(params, function (error, maxRange) {
			if (error) return callback(error);
			self._query(nearestPostcodeQuery, [longitude, latitude, maxRange, limit], handleResult);
		});
	}

	self._query(nearestPostcodeQuery, [longitude, latitude, radius, limit], handleResult);
};

var nearestPostcodeCount =  ["SELECT postcodes.*, ",
	"ST_Distance(location, ST_GeographyFromText('POINT(' || $1 || ' ' || $2 || ')')) AS distance", 
	"FROM postcodes",
	"WHERE ST_DWithin(location, ST_GeographyFromText('POINT(' || $1 || ' ' || $2 || ')'), $3)",
	"LIMIT $4"].join(" ");

var START_RANGE = 500; // 0.5km
var MAX_RANGE = 20000; // 20km
var SEARCH_LIMIT = 10;
var INCREMENT = 1000;

// _deriveMaxRange returns a 'goldilocks' range which can be fed into a reverse geocode search
// - Not so large that the query grinds to a halt because it has to process 000's of postcodes
// - Not 0
// Future improvement: Narrow down range in O(log n) time using bisect instead of linear search
Postcode.prototype._deriveMaxRange = function (params, callback) {
	var self = this;
	var queryBound = function (params, range, callback) {
		var queryParams = [params.longitude, params.latitude, range, SEARCH_LIMIT];
		self._query(nearestPostcodeCount, queryParams, function (error, result) {
			if (error) return callback(error);
			return callback(null, result.rows.length);
		});
	};

	var handleResponse = function (error, count) {
		if (error) return callback(error);
		if (count < SEARCH_LIMIT) {
			return self._deriveMaxRange(params, callback);
		} else {
			return callback(null, params.lowerBound);
		}
	};

	if (!params.lowerBound) {
		params.lowerBound = START_RANGE;
		queryBound(params, START_RANGE, handleResponse);
	} else if (!params.upperBound) {
		params.upperBound = MAX_RANGE;
		queryBound(params, MAX_RANGE, function (error, count) {
			if (count === 0) {
				return callback(null, null);
			} else {
				return self._deriveMaxRange(params, callback);
			};
		});
	} else {
		params.lowerBound += INCREMENT;
		if (params.lowerBound > MAX_RANGE) {
			return callback(null, null);
		}
		queryBound(params, params.lowerBound, handleResponse);
	}
};

var attributesQuery = [];
attributesQuery.push("array(SELECT DISTINCT districts.name FROM postcodes LEFT OUTER JOIN districts ON postcodes.admin_district_id = districts.code WHERE outcode=$1 AND districts.name IS NOT NULL) as admin_district");
attributesQuery.push("array(SELECT DISTINCT parishes.name FROM postcodes LEFT OUTER JOIN parishes ON postcodes.parish_id = parishes.code WHERE outcode=$1 AND parishes.name IS NOT NULL) as parish");
attributesQuery.push("array(SELECT DISTINCT counties.name FROM postcodes LEFT OUTER JOIN counties ON postcodes.admin_county_id = counties.code WHERE outcode=$1 AND counties.name IS NOT NULL) as admin_county");
attributesQuery.push("array(SELECT DISTINCT wards.name FROM postcodes LEFT OUTER JOIN wards ON postcodes.admin_ward_id = wards.code WHERE outcode=$1 AND wards.name IS NOT NULL) as admin_ward");


var outcodeQuery = ["SELECT outcode, avg(northings) as northings, avg(eastings) as eastings,",
	"avg(ST_X(location::geometry)) as longitude, avg(ST_Y(location::geometry)) as latitude,",
	attributesQuery.join(","),
	"FROM postcodes", 
	"WHERE outcode=$1", 
	"GROUP BY outcode;"].join(" ");


Postcode.prototype.findOutcode = function (outcode, callback) {
	var self = this;
	outcode = outcode.trim().toUpperCase();

	if (!Pc.validOutcode(outcode) && outcode !== "GIR") {
		return callback(null, null);
	}

	self._query(outcodeQuery, [outcode], function (error, result) {
		if (error) return callback(error, null);
		if (result.rows.length === 0) return callback(null, null);
		var outcodeResult = result.rows[0];
		// Swap out null result for empty arrays
		["admin_district", "parish", "admin_county", "admin_ward"].forEach(function (attribute) {
			if (outcodeResult[attribute].length === 1 && outcodeResult[attribute][0] === null) {
				outcodeResult[attribute] = [];
			}
		});
		return callback(null, outcodeResult);
	});
}

Postcode.prototype.toJson = function (address) {
	address.codes = {
		admin_district: address["admin_district_id"],
		admin_county: address["admin_county_id"],
		admin_ward: address["admin_ward_id"],
		parish: address["parish_id"],
		ccg: address["ccg_id"],
		nuts: address["nuts_code"]
	};
	delete address.id;
	delete address.location;
	delete address.pc_compact;
	delete address.admin_district_id;
	delete address.admin_county_id;
	delete address.admin_ward_id;
	delete address.parish_id;
	delete address.ccg_id;
	delete address.nuts_id;
	delete address.nuts_code;
	return address;
}

/*
*  	ONS CSV Data Reference
*
(0) pcd - Unit Postcode (7 Char)
(1) pcd2 - Unit Postcode (8 Char)
(2) pcds - Unit Postcode (Variable) 											Y
(3) dointr - Date of Introduction
(4) doterm - Date of Termnation
(5) oscty - County 																				Y
(6) oslaua - Local Authority District (LAD)								Y
(7) osward - (Electoral) Ward / Sub-division							Y
(8) usertype - Postcode User Type
(9) oseast1m - Eastings																		Y
(10) osnrth1m - Northings																	Y
(11) osgrdind - Positional Quality Indicator   						Y
(12) oshlthau - Strategic Health Authority 								Y
(13) hro - Pan SHA
(14) ctry - Country 																			Y
(15) gor - Region 																				Y
(16) streg - Standard Region (SSR)
(17) pcon - Westminster Parliamentary Constituency  		 	Y
(18) eer - European Electoral Region											Y
(19) teclec - Local Learning and Skills Council
(20) ttwa - Travel to Work Area
(21) pct - Primary Care Trust															Y
(22) nuts - LAU2 Areas																		Y
(23) psed - 1991 Census Enumeration District (code range)
(24) cened - 1991 Census Enumeration District (code)
(25) edind - ED Positional Quality Indicator
(26) oshaprev - Previous SHA
(27) lea - Local Education Authority
(28) oldha - Health Authority (old style)
(29) wardc91 - 1991 Ward (code)
(30) wardo91 - 1991 Ward (code range)
(31) ward98 - 1998 Ward
(32) statsward - 2005 Statistical Ward
(33) oa01 - 2001 Census Output Area
(34) casward - Census Area Statistics (CAS)
(35) park - National Park
(36) lsoa01 - 2001 LSOA
(37) msoa01 - 2001 MSOA
(38) ur01ind - 2001 Census (Urban / Rural Indicator)
(39) oac01 - 2001 Census Output Area Classification
(40) oldpct - Old Primary Care Trust
(41) oa11 - 2011 Census Output Areas 										Y
(42) lsoa11 - 2011 LSOA 																Y
(43) msoa11 - 2011 MSOA 																Y
(44) parish - Parish 																		Y
(45) wz11 - Census Workplace Zone
(46) ccg - Clinical Commissioning Group 								Y - NEW
(47) bua11 - Built-up Area
(48) buasd11 - Built-up Area Sub-division
(49) ru11ind - Census Rural Urban Classification - - 
*
*
*/

Postcode.prototype._setupTable = function (filePath, callback) {
	var self = this;
	self._createRelation(function (error, result) {
		if (error) return callback(error, null);
		self.clear(function (error, result) {
			if (error) return callback(error, null);
			self.seedPostcodes(filePath, function (error, result) {
				if (error) return callback(error, null);
				self.populateLocation(function (error, result) {
					if (error) return callback(error, null);
					self.createIndexes(function (error, result) {
						if (error) return callback(error, null);
						callback(null);
					});
				});
			});
		});
	});
};

Postcode.prototype.seedPostcodes = function (filePath, callback) {
	var self = this;
	var csvColumns = 	"postcode, pc_compact, eastings, northings, longitude," +
										" latitude, country, nhs_ha," + 
										" admin_county_id, admin_district_id, admin_ward_id, parish_id, quality," +
										" parliamentary_constituency , european_electoral_region, region, " +
										" primary_care_trust, lsoa, msoa, nuts_id, incode, outcode, ccg_id";
	var dataPath = path.join(__dirname, "../../data/");
	var countries = JSON.parse(fs.readFileSync(dataPath + "countries.json"));
	var nhsHa = JSON.parse(fs.readFileSync(dataPath + "nhsHa.json"));
	var constituencies = JSON.parse(fs.readFileSync(dataPath + "constituencies.json"));
	var european_registers = JSON.parse(fs.readFileSync(dataPath + "european_registers.json"));
	var regions = JSON.parse(fs.readFileSync(dataPath + "regions.json"));
	var pcts = JSON.parse(fs.readFileSync(dataPath + "pcts.json"));
	var lsoa = JSON.parse(fs.readFileSync(dataPath + "lsoa.json"));
	var msoa = JSON.parse(fs.readFileSync(dataPath + "msoa.json"));

	var transform = function (row, index) {
		// Skip if header
		if (index === 0 && row[0] === "pcd") {
			return null;
		}

		// Skip row if terminated
		if (row[4].length !== 0) {
			return null;
		}

		var finalRow = [];

		finalRow.push(row[2]);  												// postcode
		finalRow.push(row[2].replace(/\s/g, ""));				// pc_compact
		finalRow.push(row[9]);													// Eastings
		finalRow.push(row[10]);													// Northings

		var location;
		if (row[9].length === 0 || row[10].length === 0) {
			location = {
				longitude: "",
				latitude: ""
			};
		} else if (row[14] === "N92000002") {
			location = new OSPoint("" + row[10] , "" + row[9]).toWGS84("irish_national_grid");
		} else {
			location = new OSPoint("" + row[10] , "" + row[9]).toWGS84();
		}
		
		finalRow.push(location.longitude);							// longitude
		finalRow.push(location.latitude);								// latitude
		finalRow.push(countries[row[14]]);							// Country
		finalRow.push(nhsHa[row[12]]);									// NHS Health Authority
		finalRow.push(row[5]);													// County
		finalRow.push(row[6]);													// District
		finalRow.push(row[7]);													// Ward
		finalRow.push(row[44]);													// Parish
		finalRow.push(row[11]);													// Quality
		finalRow.push(constituencies[row[17]]);					// Westminster const.
		finalRow.push(european_registers[row[18]]);			// European electoral region
		finalRow.push(regions[row[15]]);								// Region
		finalRow.push(pcts[row[21]]);										// Primary Care Trusts
		finalRow.push(lsoa[row[42]]);										// 2011 LSOA
		finalRow.push(msoa[row[43]]);										// 2011 MSOA
		finalRow.push(row[22]);													// NUTS
		finalRow.push(row[2].split(" ")[1]);						// Incode
		finalRow.push(row[2].split(" ")[0]);						// Outcode
		finalRow.push(row[46]);													// Clinical Commissioning Group

		return finalRow;
	}

	self._csvSeed(filePath, csvColumns, transform, callback);
}

Postcode.prototype.populateLocation = function (callback) {
	var query = "UPDATE " + this.relation + " SET location=ST_GeogFromText" + 
							"('SRID=4326;POINT(' || longitude || ' ' || latitude || ')')" + 
							" WHERE northings!=0 AND EASTINGS!=0";
	this._query(query, callback);
}


module.exports = new Postcode();

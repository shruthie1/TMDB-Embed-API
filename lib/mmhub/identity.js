'use strict';
const SERVERS=Object.freeze({multimovies:'VidBolt',vidrift:'Vidrift',insertunit:'Insertunit',vidout:'VIDOUT',gdmirror:'GD mirror',cineverse:'Cineverse',nexus:'Nexus'});
function metadata(provider){const name=SERVERS[String(provider||'').toLowerCase()];return name?{providerGroup:'MultiMovies',serverLabel:name}:{};}
module.exports={SERVERS,metadata};

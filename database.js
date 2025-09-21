const mysql = require('mysql2');

const connection = mysql.createConnection({
    host: "localhost",
    user: "mariadb2",
    password: "1234",
    database: "pymes",
    port: 3306 // Esto es opcional, pero útil para dejar claro que se conecta a MySQL
});

connection.connect((err) => {
    if (err) {
        console.error('❌ Error al conectar a la base de datos:', err.message);
        return;
    }
    console.log('✅ Conectado a la base de datos MySQL en el puerto 3306');
});

module.exports = connection;

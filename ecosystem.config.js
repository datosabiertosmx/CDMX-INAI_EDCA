module.exports = {
    apps: [
        {
            name: 'GDMX',
            script: './captura/gdmx.js',
            cron_restart: '*/15 * * * *', // repetir cada dia
            //autorestart: false,
            env: {
                // conexion a postgres
                POSTGRES_HOST: '',
                POSTGRES_PORT: '',
                POSTGRES_NAME: '',
                POSTGRES_USER: '',
                POSTGRES_PASSWORD: '',
                // conexion del ftp
                FTP_HOST: 'localhost',
                FTP_USER: 'user',
                FTP_PASSWORD: 'password',
                FTP_DIRECTORY: '/carpeta_FTP/.',
                DOC_URL: 'http://localhost:3000',

                // credenciales del SMTP
                SMTP_HOST: 'smtp_host',
                SMTP_USER: 'user_email',
                SMTP_PASSWORD: 'password_email',
                SMTP_PORT: 'port_server_email',
                SMTP_FROM: 'smtp_from',
                SMTP_TO: 'smtp_to',
            }
        }
    ]
};

#!/bin/bash

# Set input and output file paths
input_file="/etc/openvpn/myuser.txt"
output_file="/etc/openvpn/myusertmp.txt"


ca_file="/etc/openvpn/ca.crt"
tls_file="/etc/openvpn/tc.key"
claint_cert_file="/etc/openvpn/client.crt"
claint_key_file="/etc/openvpn/client.key"

ca_content=$(<"$ca_file")
claint_cert_content=$(awk '/BEGIN/,/END CERTIFICATE/' "$claint_cert_file")
claint_key_content=$(<"$claint_key_file")
tls_content=$(<"$tls_file")

# Remove lines after "dhcp-option DNS 8.8.4.4" and append the remaining content to output file
found_dns=false
while IFS= read -r line; do
    if [[ $line == *"dhcp-option DNS 8.8.4.4"* ]]; then
        found_dns=true
        echo "$line" >> "$output_file"
        break
    fi

    if ! $found_dns; then
        echo "$line" >> "$output_file"
    fi
    
done < "$input_file"

cat <<EOF >> "$output_file"

<ca>
$ca_content
</ca>
<cert>
$claint_cert_content
</cert>
<key>
$claint_key_content
</key>
<tls-crypt>
$tls_content
</tls-crypt>
EOF

rm $input_file
mv "$output_file" "$input_file"

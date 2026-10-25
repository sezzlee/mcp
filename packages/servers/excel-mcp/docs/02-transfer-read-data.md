# Faz 2: okunan Excel verisini aktarma

Durum: kapsam önerisi. Faz 1'e dayanır; açık kararlar [ana yol haritasındadır](README.md).

## Hedef

Agent, daha önce okunan Excel'den istenen veriyi kendi cevabında yeniden üretmeden bir dosyaya veya sayfaya aktarabilsin.

## Kapsam

| Kimlik | İhtiyaç                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------- |
| F2-01  | Belirli kaynak dosya, sayfa ve hücre aralığındaki içeriği seçmek.                                       |
| F2-02  | Kolon ve koşullarla seçilmiş kayıtları, kullanıcının kastettiği kapsamda aktarmak.                      |
| F2-03  | Gruplandırılmış özet veya analiz sonucunu kaynak kayıtlarından ayrı bir çıktı türü olarak aktarabilmek. |
| F2-04  | Kaynak ve hedef kolonlarını seçmek, sıralamak ve gerektiğinde başlıklara göre eşleştirmek.              |
| F2-05  | Yeni dosyaya, yeni sayfaya veya önceki fazda oluşturulan dosyada desteklenen bir hedefe yerleştirmek.   |
| F2-06  | Sayfalama, örnekleme ve görünür kayıt seçiminin aktarımın tamamlığına etkisini ayırt etmek.             |
| F2-07  | Kaynak ile hedefteki değerlerin anlamını, sıra ve kayıt kapsamını doğrulayabilmek.                      |
| F2-08  | Kaynak dosyayı ve seçilen hedef sürümünü koruyup aktarılmış veriyi yeni çıktı sürümünde sunmak.         |

İlk aktarım kapsamı için yalnızca değerler önerilir. Formül ve biçimin de taşınması ayrı ihtiyaçtır; değer/formül/biçim/hepsi ayrımı bütün planda görünür tutulur. Transpoz ve boş kaynak hücresinin hedefi temizleyip temizlememesi ayrıca ele alınır. Excel'de görünür metin, alttaki değer ve okuma sırasında yorumlanan değer birbirinden ayrılmalıdır.

## Kodlama iş paketleri

1. Aktarılacak kaynağın ve seçimin nasıl kesin olarak tarif edileceği ihtiyacını çözmek. Bir kaynak referansı veya teknik taşıma yöntemi seçilmiş değildir.
2. Aralık, seçilmiş kayıt kümesi ve analiz sonucunun birbirinden farklı kapsamlarını ele almak.
3. İstenen verinin tamamını, önizleme ve sayfalama sınırlarına takılıp eksiltmeden aktarabilmek.
4. Kolon eşleştirme ve hedef yerleşimini Faz 1'in yazma yetenekleriyle tamamlamak.
5. Aktarım tamlığını, değerleri ve kaynakta değişiklik durumunu doğrulamak.

## Bağımlılıklar ve sınırlar

- Faz 0–1'in kaynak koruma, çıktı sürümü, tür ve toplu yazma ihtiyaçları geçerlidir.
- Kopyalanacak verinin tamamı, agent'a gösterilen önizlemeden bağımsız elde edilebilmelidir; bu belgede teknik aktarım yöntemi seçilmez.
- Kaynak ve hedefte farklı tarih sistemleri varsa aynı takvim tarihini koruma ihtiyacı değerlendirilir.
- Kaynak okuma sırasında değişmiş olabilir; daha önce görülen veriyle güncel veri arasındaki tercih belirlenmelidir.
- İlk okumanın yalnızca görünen satırları seçmesi ile kullanıcının aktarımda görünür kayıt istemesi aynı şey değildir.
- Dışarıdan gelen hedef dosyada değişiklik, Faz 3'ün koruma kapsamına bağlıdır.
- Anahtarla birleştirme ve mevcut kayıtları güncelleme Faz 4'tedir.
- Formülün son kaydedilmiş sonucu, yeniden hesaplanmış güncel sonuç olarak sunulmamalıdır. Sonucu bulunmayan formülün değer aktarımı, sıradan boş hücre gibi gösterilmemelidir. Sunucuda hesaplama Faz 6'dır.

## Kabul senaryoları

- Bir aralık, beklenen başlangıç hücresine doğru satır ve kolonlarla aktarılır.
- Agent yalnızca ilk sonuç sayfasını görmüş olsa da kullanıcı tüm eşleşenleri istediğinde tam kayıt kümesi aktarılır.
- Bilinçli olarak istenen alt küme genişletilmeden taşınır.
- Bir toplu analiz sonucu, kaynak detay kayıtlarıyla karıştırılmadan ayrı sayfaya yazılır.
- Kolon sırası farklı kaynaklar, kararlaştırılmış eşleştirmeyle doğru yerleşir.
- Kaynak değiştiğinde, kayıp veya desteklenmeyen değer bulunduğunda tamamlanma durumu gerçeği yansıtır.
- Kaynak ve önceki hedef sürümü korunur. Aktarım sonucu tam veriyi yeniden yanıtlamak yerine çıktı ve kapsam bilgisini verir.

## Açık kararlar

A-05: kaynak sürümü, örnek/tam veri ayrımı ve değer/formül/biçim taşıma kapsamı. Birden fazla kaynağın art arda eklenmesi burada basit aktarım olarak ele alınabilir; anahtarlı birleştirme Faz 4'e aittir.

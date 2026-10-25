# Faz 4: gelişmiş toplu veri işlemleri

Durum: kapsam önerisi. Faz 2 ve Faz 3'e dayanır; ortak ihtiyaçlar [ana yol haritasındadır](README.md).

## Hedef

Agent çok sayıda kayıt üzerinde, kullanıcının tarif ettiği veri işlemini topluca uygulayabilsin; eşleşme, tekrar ve tamamlanma sonucu anlaşılır olsun.

## Kapsam

| Kimlik | İhtiyaç                                                                                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| F4-01  | Koşula uyan kayıtları seçerek toplu güncellemek veya kaldırmak.                                                                              |
| F4-02  | Kayıt kimliği veya birden fazla alanla eşleştirerek güncellemek; gerekirse yeni kayıt eklemek.                                               |
| F4-03  | Bir listenin tamamını yeni veriyle değiştirmek; artan eski kayıtları açık kuralla ele almak.                                                 |
| F4-04  | Sayfa ve dosyaları alt alta birleştirmek veya anahtarla ilişkilendirmek.                                                                     |
| F4-05  | Tekrarları bulmak ve belirlenen kuralla elemek; sıralamak ve filtrelenmiş çıktı üretmek.                                                     |
| F4-06  | Kolon seçmek, yeniden adlandırmak, sıralamak; açıkça tarif edilmiş veri dönüşümlerini uygulamak.                                             |
| F4-07  | Birden çok hedef veya adımdan oluşan işin tamamını ve yeniden denemesini değerlendirmek.                                                     |
| F4-08  | Etkilenen, eklenen, değişmeyen, eşleşmeyen ve başarısız kayıtları küçük bir sonuçla ayırt edebilmek.                                         |
| F4-09  | Bir veya birden fazla kaynağı koruyup yeni çıktı sürümleri üretmek; bütün işin tamamlanma durumunu tekil çağrı sonuçlarından ayrı bildirmek. |

Filtreleme ile kayıtları kalıcı olarak kaldırmak; satır görünürlüğü ile yeni bir veri kümesi üretmek ayrı ihtiyaçlardır.

## Kodlama iş paketleri

1. Eşleşme, koşul, boş değer, sıralama ve tekrar anlamlarını belirlemek.
2. Koşullu güncelleme, listeyi yenileme ve anahtarla ekleme/güncelleme işlerini tamamlamak.
3. Birleştirme ve veri dönüştürme işlemlerini, kolon ve tür farklılıklarıyla birlikte ele almak.
4. Çok adımlı işte adım sırası, hata, kısmi sonuç ve yeniden denemeyi tamamlamak.
5. Temsili büyük veri işlerinde doğruluk, tamamlanma süresi ve kaynak limitlerini değerlendirmek.

## Bağımlılıklar ve sınırlar

- K1-09 kesindir: Birlikte tek sonuç oluşturan değişiklikler bütünüyle başarılı olmadan tamamlanmış çıktı sunulmaz. Bağımsız işlerde başarılı çıktılar sunulabilir; başarısız işler ve toplam kısmi başarı açıkça belirtilir.
- Faz 0'ın tek çağrı ve çıktı yayımlama sınırı geçerlidir. Bağımlı iş grubu ile bağımsız işler amaçlanan sonuç üzerinden ayrılır; tek çağrının güvenli kaydı bütün işin tamamlandığı anlamına gelmez.
- Toplu yazma Faz 1'de vardır; bu faz daha karmaşık veri anlamlarını ekler.
- Birleştirmede tekrar eden anahtar, boş anahtar ve birden çok eşleşme kendiliğinden çözümlenmiş sayılmaz.
- Yeni listenin eski listeden kısa olması, yalnızca ilk satırların üzerine yazılarak çözülmez.
- Yapısal değişikliklerin ilişkili içeriğe etkisi Faz 3'ün koruma kapsamına tabidir.
- Büyük veri ihtiyacı, ilk fazlardaki eksik başarısızlık veya çıktı davranışlarını erteleme gerekçesi değildir.
- İşteki bir değişikliğin sonraki adımların hedefini etkilemesi açıkça ele alınmalıdır.

## Kabul senaryoları

- Bekleyen siparişler topluca güncellenir; koşul dışındaki kayıtlar korunur.
- İki dosya anahtarla birleştirilir; eksik ve tekrarlanan anahtarlar kararlaştırılmış sonuçları verir.
- Yüz kayıtlık liste seksen kayıtla yenilenir; eski yirmi kaydın durumu beklenen biçimdedir.
- Aynı ekleme işi kesilip yeniden denendiğinde istenmeyen mükerrer kayıt oluşması kararlaştırılmış yöntemle önlenir veya açıkça bildirilir.
- Bir raporu birlikte oluşturan sayfa işlemlerinden biri başarısızsa gruptan tamamlanmış yeni rapor sunulmaz; kaynaklar ve önceki sürüm değişmez.
- On bağımsız rapordan biri başarısızsa dokuz başarılı çıktı sunulabilir; başarısız rapor ve toplam kısmi başarı açıkça bildirilir.
- Başarısız bağımsız iş yeniden denenirken tamamlanan işler yanlışlıkla tekrar uygulanmaz.
- Değişiklik tamamlanıp yanıt kaybolduktan sonra tekrar denendiğinde, iş sonucu bulunabilir veya kararlaştırılmış yeniden deneme davranışı uygulanır; mükerrer çıktı/kayıt başarılı yeni iş gibi sunulmaz.
- Temsili büyük işte kayıt sayıları yanında örnek değerler, hedefler ve eşleşme sonuçları da doğrulanır.

## Açık kararlar

A-08 ve iş geri alma açısından A-11: anahtar ve karşılaştırma kuralları, büyük/küçük harf, boş değer, çakışma, sıra, iş gruplama, sonuç bildirimi ve yeniden deneme. Bağlı işte bütünlük ve bağımsız işte açık kısmi başarı ilkesi K1-09 ile kesindir. Sayısal ölçek ve süre hedefleri gerçek iş örnekleriyle belirlenir; bu belgede ölçülmemiş kapasite vaadi yoktur.
